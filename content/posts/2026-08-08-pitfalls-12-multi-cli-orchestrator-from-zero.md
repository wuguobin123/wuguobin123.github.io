---
title: "实战踩坑录 12 · 多 CLI 编排器从零设计：DAG + 状态机 + git worktree + artifact handoff"
date: "2026-08-08"
description: "0→1 设计一个多 CLI agent 编排器：每个 worker 在独立 git worktree 跑，按 DAG 依赖调度，跨 worker 通信靠 artifact handoff。状态原子写、事件流追加、串行派发先打稳再放开并行。"
tags: [Multi-Agent, CLI, DAG, 状态机, Git Worktree, Python]
draft: true
---

## 一、Context

需要一个**多 CLI 智能体编排执行器**，使用流程：

1. `codex`（已有的另一个 CLI）做需求分析 + 模块化拆解，产出一份 DAG YAML。
2. **本工具**（codex-orchestrator）读 DAG、按依赖关系调度 worker。
3. 每个 worker 在独立 git worktree 里跑（`kimi` / `claude` / `codex` / `mock` / `shell`）。
4. Worker 只在依赖完成时被唤醒；跨 worker 通信靠**文件工件（artifact）handoff**。

核心约束：只在有依赖时通信/等待，其余时间各 worker 互不感知；每个模块/任务独立 worktree，避免相互污染。

---

## 二、目录结构

```
/Users/wuguobin/Documents/code/local-source/codex-orchestrator/
├── pyproject.toml
├── README.md
├── src/codex_orchestrator/
│   ├── __init__.py
│   ├── __main__.py                # python -m codex_orchestrator
│   ├── cli.py                     # click CLI
│   ├── contracts.py               # Pydantic DTO
│   ├── dag.py                     # 验证 + 拓扑 + 依赖计算
│   ├── state.py                   # 原子化 JSON 状态存储
│   ├── events.py                  # append-only 事件流
│   ├── worktree.py                # git worktree 生命周期
│   ├── worker.py                  # 子进程派发 + 输入物化 + 产物收集
│   ├── runtime.py                 # 主循环（状态机驱动）
│   └── prompts.py                 # 给 worker 的 prompt 模板
├── tests/
│   ├── conftest.py
│   ├── test_dag.py
│   ├── test_state.py
│   ├── test_events.py
│   ├── test_runtime.py            # 用 mock runtime 端到端
│   └── fixtures/mock_worker.py
├── examples/
│   ├── dag.simple.yaml            # 3 任务串行
│   └── dag.parallel.yaml          # 演示并行扇出 + 扇入
└── docs/dag-schema.md
```

依赖：生产 `pydantic>=2` / `pyyaml>=6` / `click>=8`；开发 `pytest>=8` / `pytest-cov` / `ruff`。**不引入** langgraph / fastapi / apscheduler。

---

## 三、核心数据模型

```python
# src/codex_orchestrator/contracts.py
from enum import StrEnum
from pydantic import BaseModel

class TaskState(StrEnum):
    PENDING  = "pending"
    READY    = "ready"
    RUNNING  = "running"
    DONE     = "done"
    FAILED   = "failed"
    BLOCKED  = "blocked"     # 上游失败导致无法继续
    SKIPPED  = "skipped"

class TaskRuntime(StrEnum):
    KIMI   = "kimi"
    CLAUDE = "claude"
    CODEX  = "codex"
    MOCK   = "mock"          # 测试用
    SHELL  = "shell"         # 直接 shell 命令

class ArtifactRef(BaseModel):
    from_task: str
    path: str                # 相对于源 worktree

class TaskSpec(BaseModel):
    id: str
    runtime: TaskRuntime
    description: str
    worktree_base: str | None = None     # 默认从 --repo 创建
    depends_on: list[str] = []
    consumes: list[ArtifactRef] = []
    produces: list[str] = []             # 路径列表，相对 worktree
    timeout_seconds: int = 1800
    env: dict[str, str] = {}
    retry_max: int = 0
    shell_cmd: str | None = None         # 仅 SHELL runtime

class Dag(BaseModel):
    version: int = 1
    repo: str | None = None              # 默认仓库根
    worktree_parent: str = "../wt"
    tasks: list[TaskSpec]
```

`Dag` 校验（`dag.py`）要覆盖：循环检测、悬空引用（`consumes.from_task` 不存在）、重复 id、`produces` 路径不能含 `..`。

---

## 四、状态机

合法转移：

```
PENDING ──deps 全 DONE──▶ READY ──派发──▶ RUNNING ──exit 0──▶ DONE
   │                        │              │                    │
   │                        │              └─exit !=0 / 超时──▶ FAILED
   │                        │                                    │
   │                        └──上游 FAILED──▶ BLOCKED            └─影响下游──▶ BLOCKED
   └──────────────────────────────取消─────────────────────────▶ (终止主循环)
```

### 原子写状态

```python
# src/codex_orchestrator/state.py
import fcntl, json, tempfile, os
from pathlib import Path

class StateStore:
    def __init__(self, state_dir: Path):
        self._dir = state_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        self._path = state_dir / "state.json"
        self._lock_path = state_dir / ".state.lock"

    def _flock(self):
        self._lock_fd = open(self._lock_path, "w")
        fcntl.flock(self._lock_fd, fcntl.LOCK_EX)

    def _funlock(self):
        fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
        self._lock_fd.close()

    def load(self) -> dict:
        if not self._path.exists():
            return {"tasks": {}, "version": 0}
        with self._path.open() as f:
            return json.load(f)

    def save(self, state: dict) -> None:
        """原子写：tmp + rename"""
        with self._flock():
            tmp = self._path.with_suffix(".tmp")
            with tmp.open("w") as f:
                json.dump(state, f, indent=2, sort_keys=True)
            os.replace(tmp, self._path)        # 原子替换
```

`os.replace` 在 POSIX 上是原子操作；断电时最多丢失最近一次写入，不会出现「半截 JSON」。

### 事件流

```python
# src/codex_orchestrator/events.py
import json, time
from pathlib import Path

class EventLog:
    def __init__(self, state_dir: Path):
        self._path = state_dir / "events.ndjson"

    def append(self, *, event: str, task_id: str, **fields) -> None:
        rec = {"ts": time.time(), "event": event,
               "task_id": task_id, **fields}
        with self._path.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        f.flush()
        os.fsync(f.fileno())              # 落盘
```

`append-only` + `fsync` 是为了「事后回放 + 调试可视化」。每条事件记录一次状态转移，便于复盘。

---

## 五、worker 派发

### 输入物化

每个 worker 在独立 worktree 跑；启动前先把上游 `produces` 物化到当前 worktree：

```python
def materialize_inputs(task: TaskSpec, prev_artifacts: dict[str, Path],
                       worktree: Path) -> None:
    for ref in task.consumes:
        src_artifact_dir = prev_artifacts[ref.from_task]   # .orch/artifacts/<from_task>/
        src = src_artifact_dir / ref.path
        if not src.exists():
            raise OrchestratorError(f"{ref.from_task} 未产出 {ref.path}")
        dst = worktree / ref.path
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
```

### 完成信号

worker 完成时 touch `<worktree>/.done`；如果需要外部决策，touch `<worktree>/.block` 写明原因：

```python
# in mock_worker.py
import os, sys, time, pathlib, json
wt = pathlib.Path(sys.argv[1])
task_json = json.loads((wt / "task.json").read_text())
# ... 干活 ...
(wt / "src/api/contracts.py").write_text("# generated")
(wt / ".done").touch()
```

### 子进程派发

```python
def dispatch(task: TaskSpec, worktree: Path, prompt: str,
             timeout: int) -> int:
    cmd = {
        TaskRuntime.MOCK:   ["python", "fixtures/mock_worker.py", str(worktree)],
        TaskRuntime.SHELL:  ["sh", "-c", task.shell_cmd],
        TaskRuntime.KIMI:   ["kimi", "--new", prompt, "--workdir", str(worktree)],
        TaskRuntime.CLAUDE: ["claude", "--print", prompt, "--workdir", str(worktree)],
        TaskRuntime.CODEX:  ["codex", "--prompt", prompt, "--workdir", str(worktree)],
    }[task.runtime]

    env = os.environ.copy()
    env.update(task.env)

    proc = subprocess.Popen(cmd, cwd=worktree, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        return proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise OrchestratorError(f"{task.id} 超时")
```

### 产物采集

```python
def collect_outputs(task: TaskSpec, worktree: Path,
                    artifacts_root: Path) -> Path:
    out_dir = artifacts_root / task.id
    out_dir.mkdir(parents=True, exist_ok=True)
    for path_str in task.produces:
        src = worktree / path_str
        if not src.exists():
            raise OrchestratorError(f"{task.id} 期望产出 {path_str} 但不存在")
        dst = out_dir / path_str
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
    return out_dir
```

---

## 六、Worktree 生命周期

```python
# src/codex_orchestrator/worktree.py
def create(repo: Path, task_id: str, parent: Path) -> Path:
    wt = parent / f"wt-{task_id}"
    if wt.exists():
        return wt      # 恢复场景：run 重入时不重建
    branch = f"orch/{task_id}"
    subprocess.run(
        ["git", "-C", str(repo), "worktree", "add", "-b", branch, str(wt), "HEAD"],
        check=True,
    )
    return wt

def maybe_merge(repo: Path, task_id: str, worktree: Path) -> None:
    branch = f"orch/{task_id}"
    subprocess.run(["git", "-C", str(repo), "merge", "--no-ff", branch], check=True)
    subprocess.run(["git", "-C", str(repo), "worktree", "remove", str(worktree)], check=True)
    subprocess.run(["git", "-C", str(repo), "branch", "-d", branch], check=True)
```

失败时默认保留 worktree 供调试；只有显式 `--merge-on-success` 才合并。

---

## 七、主循环（runtime.py）

```python
def run(dag: Dag, repo: Path, state_dir: Path, max_parallel: int = 1) -> None:
    store = StateStore(state_dir)
    log = EventLog(state_dir)
    state = store.load()
    artifacts_root = state_dir / "artifacts"
    procs: dict[str, subprocess.Popen] = {}

    while True:
        # 1. 推进 PENDING → READY（依赖全 DONE）
        for t in dag.tasks:
            if state["tasks"].get(t.id, {}).get("state") != TaskState.PENDING:
                continue
            deps = {state["tasks"].get(d, {}).get("state") for d in t.depends_on}
            if deps == {TaskState.DONE}:
                state["tasks"][t.id] = {"state": TaskState.READY}
                log.append(event="TASK_READY", task_id=t.id)
            elif TaskState.FAILED in deps or TaskState.BLOCKED in deps:
                state["tasks"][t.id] = {"state": TaskState.BLOCKED}
                log.append(event="TASK_BLOCKED", task_id=t.id)

        # 2. 选 READY 中未超过 max_parallel 的 → 派发
        running_count = sum(1 for s in state["tasks"].values()
                            if s.get("state") == TaskState.RUNNING)
        for t in dag.tasks:
            if running_count >= max_parallel:
                break
            if state["tasks"].get(t.id, {}).get("state") != TaskState.READY:
                continue
            wt = create(repo, t.id, repo.parent / dag.worktree_parent)
            materialize_inputs(t, prev_artifacts=load_artifacts(state),
                               worktree=wt)
            prompt = build_prompt(t)
            try:
                procs[t.id] = dispatch(t, wt, prompt, t.timeout_seconds)
            except OrchestratorError as e:
                state["tasks"][t.id] = {"state": TaskState.FAILED,
                                        "error": str(e)}
                log.append(event="TASK_FAILED", task_id=t.id, error=str(e))
                continue
            state["tasks"][t.id] = {"state": TaskState.RUNNING}
            log.append(event="TASK_DISPATCHED", task_id=t.id)
            running_count += 1

        # 3. 轮询 RUNNING
        for t in dag.tasks:
            s = state["tasks"].get(t.id, {})
            if s.get("state") != TaskState.RUNNING:
                continue
            proc = procs[t.id]
            if proc.poll() is None:
                continue
            rc = proc.returncode
            if rc == 0:
                collect_outputs(t, wt, artifacts_root)
                state["tasks"][t.id] = {"state": TaskState.DONE, "rc": rc}
                log.append(event="TASK_COMPLETED", task_id=t.id)
            else:
                state["tasks"][t.id] = {"state": TaskState.FAILED,
                                        "rc": rc}
                log.append(event="TASK_FAILED", task_id=t.id, rc=rc)
        store.save(state)

        # 4. 终态判定
        states = {s.get("state") for s in state["tasks"].values()}
        if states <= {TaskState.DONE, TaskState.SKIPPED, TaskState.BLOCKED}:
            log.append(event="DAG_COMPLETED", task_id="*")
            return
        if TaskState.FAILED in states and not any(
            s.get("state") == TaskState.PENDING for s in state["tasks"].values()
        ):
            log.append(event="DAG_FAILED", task_id="*")
            return

        time.sleep(0.5)         # 轮询间隔
```

**v1 先做串行派发**（`max_parallel=1`），调度逻辑不依赖并发度；放开并行时不用改主循环结构。

---

## 八、CLI

```python
# src/codex_orchestrator/cli.py
import click

@click.group()
def cli(): ...

@cli.command()
@click.option("--dag", required=True, type=click.Path(exists=True))
@click.option("--repo", default=".")
@click.option("--max-parallel", default=1, type=int)
@click.option("--state-dir", default=".orch")
@click.option("--merge-on-success", is_flag=True)
def run(dag, repo, max_parallel, state_dir, merge_on_success): ...

@cli.command()
@click.option("--dag", required=True)
@click.option("--state-dir", default=".orch")
def status(dag, state_dir): ...                # 表格输出

@cli.command()
@click.option("--dag", required=True)
def validate(dag): ...                          # 仅校验，不跑

@cli.command()
@click.option("--state-dir", default=".orch")
@click.option("--follow", is_flag=True)
@click.option("--task", default=None)
def events(state_dir, follow, task): ...        # 事件流回放

@cli.command()
@click.option("--state-dir", default=".orch")
@click.option("--yes", is_flag=True)
def reset(state_dir, yes): ...                  # 清状态 / .trash wt
```

`pyproject.toml` 注册 console script：`codex-orch = "codex_orchestrator.cli:main"`。

---

## 十、示例 DAG

```yaml
# examples/dag.simple.yaml
version: 1
repo: .
tasks:
  - id: write-contract
    runtime: mock
    description: "Write API contract"
    produces: [contracts/api.yaml]

  - id: implement-backend
    runtime: mock
    description: "Implement backend"
    depends_on: [write-contract]
    consumes:
      - {from_task: write-contract, path: contracts/api.yaml}
    produces: [src/api/]

  - id: implement-frontend
    runtime: mock
    description: "Implement frontend"
    depends_on: [write-contract]
    consumes:
      - {from_task: write-contract, path: contracts/api.yaml}
    produces: [src/web/]

  - id: e2e-test
    runtime: mock
    description: "Run e2e"
    depends_on: [implement-backend, implement-frontend]
    produces: [reports/e2e.html]
```

---

## 十一、验证

```bash
cd /Users/wuguobin/Documents/code/local-source/codex-orchestrator
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

ruff check src tests
pytest -q                       # 全绿

codex-orch validate --dag examples/dag.simple.yaml
# 期望: "✓ DAG valid: 4 tasks, no cycles"

codex-orch run --dag examples/dag.simple.yaml --repo . --max-parallel 2
# 期望: 4 个任务按依赖推进，最终 DAG_COMPLETED

codex-orch status --dag examples/dag.simple.yaml
# 期望: 全部 DONE，产物路径列出

codex-orch events
# 期望: TASK_READY → TASK_DISPATCHED → TASK_COMPLETED 序列

# 失败传播：临时把某任务的 produces 路径设为不可写，跑一遍，断言下游变 BLOCKED
```

---

## 十二、显式不做（v1 范围外）

- ❌ LLM 驱动的需求拆解（DAG 生成）—— 那是 `codex` 自己的事
- ❌ 真正的并行（先串行跑通再放开 `max_parallel`）
- ❌ Retry / backoff（先 `retry_max=0`）
- ❌ 取消 token / 中途回滚
- ❌ TUI / Web 仪表盘（用 `status` + `events --follow` 命令行替代）
- ❌ 跨机器协作 / 远程 worker
- ❌ 审批门 / 人工 gate

---

## 十三、可复用清单 · 多 CLI 编排器设计

1. **状态机驱动，不要「事件回调」**：PENDING → READY → RUNNING → DONE/FAILED/BLOCKED 一张表写明白，比 callback 链路清晰。
2. **状态写用 atomic rename + flock**：崩溃恢复可读、单进程内无并发问题。
3. **事件流 append-only + fsync**：事后回放和调试靠它，不要用日志替代。
4. **每个 worker 一个 git worktree**：污染隔离天然成立；失败时 worktree 留下来调试，--merge-on-success 才合并。
5. **跨 worker 通信只走 artifact handoff**：状态机本身是消息总线；worker 之间不直接调用。
6. **v1 串行派发**：调度逻辑与并发度解耦，先打稳再放开 `max_parallel`。
7. **mock runtime 优先**：端到端测试用 `mock_worker.py`，CI 不依赖真实 kimi/claude。
8. **scope 控制**：先做「单仓库单 worktree 父目录」，跨机器 / 远程 worker 留给 v2。

---

## 十四、相关坑

- [[2026-08-08-pitfalls-09-codex-subagent-toml-not-loaded]] · 单会话内的子代理派发 vs 跨 CLI 编排是两层抽象：前者靠 AGENTS.md 调度约定，后者靠 DAG + 状态机。两者思路相通（设计者/执行者分离），但实现完全不同。
- [[2026-08-08-pitfalls-01-python-sqlite3-context-rollback]] · 如果状态改用 SQLite 而不是 JSON 文件，第 01 篇的「块内 raise → 回滚」坑会再踩一次——这里用 atomic rename 是更简单的选择。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · 单进程内 agent 的 capability 是「同步可调用的工具」；多 CLI 编排的 worker 是「独立子进程跑另一个 CLI」。两者抽象层级不同，但「输入/输出契约清晰」的要求一致。