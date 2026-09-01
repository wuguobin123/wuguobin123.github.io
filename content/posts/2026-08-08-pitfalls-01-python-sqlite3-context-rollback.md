---
title: "实战踩坑录 01 · Python `with sqlite3.connect()` 异常回滚：先写后抛导致计数没生效"
date: "2026-08-08"
description: "在 `with sqlite3.connect() as conn:` 块内先 UPDATE 再 raise，会回滚所有未提交写入。要么在 raise 前显式 commit，要么把错误对象构造放到块外。"
tags: [Python, SQLite, 上下文管理器, 事务, 复盘]
draft: true
---

## 一、症状

注册流程接入邮箱验证码时，跑完端到端用例：

```text
预期：错码提交后，attempts 计数 +1，5 次之后锁定 30 分钟
实际：第 1 次错码后 attempts 还是 0；第 6 次错码依旧能验证（因为根本没锁定）
```

排查日志发现：服务每次都进了 `verify_code` 的「错误码」分支，`INSERT/REPLACE` 也跑过了，但 `SELECT attempts FROM wb_email_verification_codes` 永远是 0。

---

## 二、根因

问题代码长这样（简化）：

```python
class EmailVerificationService:
    async def verify_code(self, email: str, code: str) -> None:
        with self.connect() as conn:                       # ← 进入事务
            row = conn.execute("SELECT ...").fetchone()
            if row["attempts"] >= self.max_attempts:
                raise EmailVerificationError("CODE_LOCKED", "已锁定")
            if not hmac.compare_digest(...):
                conn.execute(
                    "UPDATE ... SET attempts = attempts + 1, locked_until = ?",
                    (now + lockout,),
                )
                if row["attempts"] + 1 >= self.max_attempts:
                    raise EmailVerificationError("CODE_LOCKED", "已锁定")  # ← 在块内 raise
            else:
                conn.execute("DELETE ...")
```

`sqlite3` 的 connection 作为 context manager 时的语义是：

- 正常退出 → `commit()`
- 异常退出 → `rollback()`

也就是说，**块内任何一行 `raise`，整段已经执行的 `INSERT/UPDATE/DELETE` 全部回滚**。

我当时踩到的实际坑是：

1. 第一次错码 → `UPDATE attempts = 1` → 紧接着 `raise` → 整个事务回滚 → `attempts` 还是 0。
2. 第二次错码 → 同样回滚。
3. ……
4. 第六次错码 → 仍然回滚 → 永远到不了锁定阈值。

直觉上「我先更新计数、发现要锁定就抛异常」是个合理写法，但 sqlite3 的 `__exit__` 不区分「这是业务异常需要回滚」和「这是参数非法需要回滚」——它对所有异常一视同仁。

---

## 三、修复

两种写法都可以，按场景选。

### 写法 A：在 raise 前显式 commit

```python
with self.connect() as conn:
    row = conn.execute("SELECT ...").fetchone()
    if row["attempts"] >= self.max_attempts:
        raise EmailVerificationError("CODE_LOCKED", "已锁定")
    if not hmac.compare_digest(...):
        conn.execute(
            "UPDATE ... SET attempts = attempts + 1, locked_until = ?",
            (now + lockout,),
        )
        conn.commit()                                      # ← 显式提交计数
        if row["attempts"] + 1 >= self.max_attempts:
            raise EmailVerificationError("CODE_LOCKED", "已锁定")
    else:
        conn.execute("DELETE ...")
        # 正常退出，__exit__ 自动 commit
```

缺点：散落 `commit()`，将来维护容易遗漏。

### 写法 B（推荐）：错误对象在块外构造，块内只做纯写入

```python
err: EmailVerificationError | None = None

with self.connect() as conn:
    row = conn.execute("SELECT ...").fetchone()
    if row["attempts"] >= self.max_attempts:
        err = EmailVerificationError("CODE_LOCKED", "已锁定")
    elif not hmac.compare_digest(...):
        conn.execute(
            "UPDATE ... SET attempts = attempts + 1, locked_until = ?",
            (now + lockout,),
        )
        if row["attempts"] + 1 >= self.max_attempts:
            err = EmailVerificationError("CODE_LOCKED", "已锁定")
    else:
        conn.execute("DELETE ...")
# 块外 raise：事务已 commit，状态已落库
if err is not None:
    raise err
```

优点：块内只有「写」和「构造错误对象」两种动作，没有任何「先写后抛」；context manager 自然 commit 一次。如果将来加新的「先写后抛」分支，模式上就很难再写错。

我最终用的是写法 B，单测里加了三条断言锁死这个语义：

```python
def test_wrong_code_increments_attempts():
    service.verify_code("a@b.com", "000000")
    row = service._select_row("a@b.com")
    assert row["attempts"] == 1                       # 之前这里永远 == 0

def test_lock_after_max_attempts():
    for _ in range(5):
        with pytest.raises(EmailVerificationError):
            service.verify_code("a@b.com", "000000")
    # 第 6 次直接锁定
    with pytest.raises(EmailVerificationError) as ei:
        service.verify_code("a@b.com", "000000")
    assert ei.value.code == "CODE_LOCKED"
```

---

## 四、可复用清单

下次写「先写后抛」模式前先问三个问题：

1. **这块 `with` 后面会不会 `raise`？** 如果会，commit 要么前置、要么用「块外构造错误对象」。
2. **错误是「参数非法」（应当回滚）还是「业务失败」（应当落库）？** 前者保留默认 rollback，后者必须先 commit。
3. **错误码在 HTTP 层会被映射成 4xx 还是 5xx？** 4xx 通常意味着「客户端行为不当」，5xx 通常意味着「服务端状态变更」——分清楚再决定要不要 commit。

补充三条 sqlite3 特定的注意事项：

- sqlite3 默认 `isolation_level=""`（自动提交），但 `with` 块显式开启事务；不要混用。
- 想要细粒度控制就显式 `BEGIN` / `COMMIT` / `ROLLBACK`，不要再靠 context manager。
- 测试时用 `clock` 注入推进时间，避免 `sleep` 拖慢 CI。

---

## 五、相关坑

- [[2026-08-08-pitfalls-10-email-verification-full-pipeline]] · 同一份 `EmailVerificationService` 里除了 `verify_code`，`request_code` 也是「先写后发邮件」——邮件发送失败要不要回滚计数？同样要在块外决定。
- [[2026-08-08-pitfalls-03-frontend-auth-tenant-mismatch]] · 前端把后端 401 当成「显示『未授权』」处理；后端的事务回滚 / 写入失败如果没显式 commit，前端什么提示都收不到。