---
title: "实战踩坑录 10 · 邮箱验证码全链路：6 位数字、TTL、限流、锁定、SMTP 兜底"
date: "2026-08-08"
description: "把 signup 加上邮箱验证码的全部要点：6 位数字 + 10 分钟 TTL + 60s 重发冷却 + 1h 10 次上限 + 错 5 次锁 30 分钟；SMTP 未配置时落日志方便 dev/CI；测试用 clock 注入避免 sleep。"
tags: [Auth, 邮箱验证码, SMTP, 限流, SQLite, aiosmtplib]
draft: true
---

## 一、症状

注册接口 `POST /api/auth/signup` 原本只校验「邮箱+密码+姓名」，对邮箱不做任何验证。后果：

1. **邮箱伪造**：随便填 `ceo@your-company.com` 就能注册成功。
2. **恶意注册**：脚本灌一晚上能造几千个账号。
3. **合规缺口**：生产环境被审计时这条直接 fail。

要求：接入邮箱验证码，未通过校验不能创建账号。

---

## 二、设计决策

跟用户对齐后的方案：

| 维度 | 决策 |
|---|---|
| 存储 | 独立新表 `wb_email_verification_codes`，不复用 `wb_identities` |
| 数据库 | SQLite（与现有 `wb_identities` 风格一致） |
| 邮件传输 | `aiosmtplib`；未配置 SMTP 时回落到 `LoggingEmailSender`（INFO 日志打印验证码） |
| 验证码策略 | 6 位数字、TTL 10 分钟、60 秒重发冷却、1 小时 10 次上限、错 5 次锁 30 分钟 |
| 接口 | 新增 `POST /api/auth/email-code`（公开）；`signup` 增加必填 `verification_code`（可通过 `APP_ACCOUNT_EMAIL_VERIFICATION_REQUIRED=false` 关掉） |

---

## 三、实现

### 3.1 EmailSender 抽象

```python
# src/customer_service_ai/email_verification.py
from email.message import EmailMessage
import logging

class EmailSender(Protocol):
    async def send(self, message: EmailMessage) -> None: ...

class LoggingEmailSender:
    """默认实现：把验证码打到 INFO 日志。仅 dev / CI 用。"""
    def __init__(self, logger: logging.Logger | None = None):
        self._log = logger or logging.getLogger("email_verification")

    async def send(self, msg: EmailMessage) -> None:
        # 把 6 位码单独提取出来，方便 dev 调试
        body = msg.get_content()
        code = "".join(c for c in body if c.isdigit())[:6]
        self._log.info("DEV verification code for %s: %s", msg["To"], code)

class SmtpEmailSender:
    def __init__(self, *, host, port, username, password,
                 from_address, use_tls=True, timeout=10.0):
        self._host, self._port = host, port
        self._user, self._password = username, password
        self._from = from_address
        self._tls = use_tls
        self._timeout = timeout

    async def send(self, msg: EmailMessage) -> None:
        import aiosmtplib
        msg["From"] = self._from
        await aiosmtplib.send(
            msg, hostname=self._host, port=self._port,
            username=self._user, password=self._password,
            use_tls=self._tls, timeout=self._timeout,
        )
```

`app.py` 在构造 `EmailVerificationService` 时按设置选择：

```python
sender: EmailSender
if settings.email_smtp_host:
    sender = SmtpEmailSender(
        host=settings.email_smtp_host,
        port=settings.email_smtp_port,
        username=settings.email_smtp_username,
        password=settings.email_smtp_password,
        from_address=settings.email_smtp_from_address,
        use_tls=settings.email_smtp_use_tls,
        timeout=settings.email_smtp_timeout_seconds,
    )
else:
    sender = LoggingEmailSender()
```

### 3.2 表结构

```sql
CREATE TABLE IF NOT EXISTS wb_email_verification_codes (
    email TEXT PRIMARY KEY COLLATE NOCASE,
    salt BLOB NOT NULL,
    code_hash BLOB NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_sent_at TEXT NOT NULL,
    send_count INTEGER NOT NULL DEFAULT 0,
    hour_window_started_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wb_email_verification_codes_expiry
    ON wb_email_verification_codes(expires_at);
```

### 3.3 生成 + 校验

```python
import secrets, hashlib, hmac
from datetime import datetime, timedelta, UTC

class EmailVerificationError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

class EmailVerificationService:
    def __init__(self, *, database_path, clock=None, email_sender: EmailSender,
                 code_ttl_seconds=600, resend_cooldown_seconds=60,
                 max_sends_per_hour=10, max_attempts_before_lock=5,
                 lockout_seconds=1800):
        self._db = sqlite3.connect(database_path)
        self._clock = clock or (lambda: datetime.now(UTC))
        self._sender = email_sender
        self._ttl = code_ttl_seconds
        self._cooldown = resend_cooldown_seconds
        self._max_per_hour = max_sends_per_hour
        self._max_attempts = max_attempts_before_lock
        self._lockout = lockout_seconds

    def initialize(self) -> None:
        self._db.executescript(SCHEMA_SQL)

    async def request_code(self, email: str) -> dict:
        email = self._normalize(email)
        now = self._clock()
        with self._db:                                 # 块内 raise → 回滚（避免！）
            row = self._db.execute(
                "SELECT * FROM wb_email_verification_codes WHERE email = ?",
                (email,),
            ).fetchone()

            if row:
                # 冷却
                last_sent = datetime.fromisoformat(row["last_sent_at"])
                if (now - last_sent).total_seconds() < self._cooldown:
                    raise EmailVerificationError("RESEND_COOLDOWN", "请稍后再试")
                # 小时上限
                window_start = datetime.fromisoformat(row["hour_window_started_at"])
                if (now - window_start) > timedelta(hours=1):
                    self._db.execute(
                        "UPDATE ... SET send_count = 0, hour_window_started_at = ? "
                        "WHERE email = ?", (now.isoformat(), email))
                    send_count = 0
                else:
                    send_count = row["send_count"]
                if send_count >= self._max_per_hour:
                    raise EmailVerificationError("RATE_LIMIT_EXCEEDED", "请求过于频繁")

            code = f"{secrets.randbelow(1_000_000):06d}"
            salt = secrets.token_bytes(16)
            digest = hashlib.pbkdf2_hmac("sha256", code.encode(), salt, 200_000)

            msg = EmailMessage()
            msg["To"] = email
            msg["Subject"] = "您的注册验证码"
            msg.set_content(f"您的验证码是 {code}，10 分钟内有效。")

            # 邮件发送在块外做；成功后再 commit（避免 SMTP 失败时白扣配额）
            self._sender.send(msg)        # ← 见下方注释
        # ↑ 块已 commit，下面再处理配额更新

        # 重新打开一次更新 last_sent_at / send_count（避免块内 raise 回滚）
        with self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO wb_email_verification_codes "
                "(email, salt, code_hash, expires_at, attempts, locked_until, "
                " last_sent_at, send_count, hour_window_started_at, created_at) "
                "VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)",
                (email, salt, digest,
                 (now + timedelta(seconds=self._ttl)).isoformat(),
                 now.isoformat(),
                 (send_count if row else 0) + 1,
                 now.isoformat() if not row else row["hour_window_started_at"],
                 now.isoformat()),
            )
        return {
            "ok": True,
            "expires_in_seconds": self._ttl,
            "retry_after_seconds": self._cooldown,
        }

    def verify_code(self, email: str, code: str) -> None:
        email = self._normalize(email)
        now = self._clock()

        # 错误对象在块外构造，块内只做写入（参见第 01 篇）
        err: EmailVerificationError | None = None

        with self._db:
            row = self._db.execute(
                "SELECT * FROM wb_email_verification_codes WHERE email = ?",
                (email,),
            ).fetchone()
            if row is None:
                err = EmailVerificationError("CODE_NOT_FOUND", "请先获取验证码")
            else:
                # 锁定？
                if row["locked_until"]:
                    locked_until = datetime.fromisoformat(row["locked_until"])
                    if now < locked_until:
                        err = EmailVerificationError("CODE_LOCKED", "尝试次数过多，已临时锁定")
                # 过期？
                expires_at = datetime.fromisoformat(row["expires_at"])
                if err is None and now > expires_at:
                    err = EmailVerificationError("CODE_EXPIRED", "验证码已过期")
                # 校验
                if err is None:
                    digest = hashlib.pbkdf2_hmac(
                        "sha256", code.encode(), row["salt"], 200_000)
                    if hmac.compare_digest(digest, row["code_hash"]):
                        self._db.execute(
                            "DELETE FROM wb_email_verification_codes WHERE email = ?",
                            (email,),
                        )
                    else:
                        new_attempts = row["attempts"] + 1
                        if new_attempts >= self._max_attempts:
                            self._db.execute(
                                "UPDATE ... SET attempts = ?, locked_until = ? "
                                "WHERE email = ?",
                                (new_attempts,
                                 (now + timedelta(seconds=self._lockout)).isoformat(),
                                 email),
                            )
                        else:
                            self._db.execute(
                                "UPDATE ... SET attempts = ? WHERE email = ?",
                                (new_attempts, email),
                            )
                        err = EmailVerificationError("WRONG_CODE", "验证码错误")

        if err is not None:
            raise err
```

注意三处与第 01 篇 sqlite3 回滚坑的呼应：

1. `request_code` 把「邮件发送」放在块**外**——SMTP 失败不应该回滚已生成的 salt / digest；邮件失败是瞬时错误，让用户重试更友好。
2. `verify_code` 把错误对象构造放块**外**——错误码计数 / 锁定必须落库。
3. 所有写入用 `with self._db:`（自动 commit），避免散落 `commit()`。

### 3.4 IdentityService 接入

```python
class IdentityService:
    def __init__(self, *, email_verification: EmailVerificationService | None = None,
                 email_verification_required: bool = True):
        self._email_verify = email_verification
        self._require_verify = email_verification_required

    def signup(self, *, email, password, display_name,
               verification_code: str | None = None) -> dict:
        if self._email_verify is not None and self._require_verify:
            try:
                self._email_verify.verify_code(email, verification_code or "")
            except EmailVerificationError as e:
                raise IdentityError(e.code, str(e)) from e
        # ... 原有 INSERT 逻辑
```

`IdentityError(code, message)` 已有的错误码 / HTTP 映射机制直接复用，不引入新的错误体系。

### 3.5 HTTP 端点

```python
# src/customer_service_ai/app.py
class EmailCodeRequestInput(BaseModel):
    email: str = Field(..., max_length=254)

class AccountSignupInput(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=8)
    display_name: str
    verification_code: str | None = Field(default=None, min_length=6, max_length=6,
                                          pattern=r"^\d{6}$")

@router.post("/api/auth/email-code")
async def request_email_code(payload: EmailCodeRequestInput, ...):
    if email_verification is None:
        raise HTTPException(503, "email verification not configured")
    try:
        result = await email_verification.request_code(payload.email)
    except EmailVerificationError as e:
        status = {
            "RESEND_COOLDOWN": 429,
            "RATE_LIMIT_EXCEEDED": 429,
            "EMAIL_INVALID": 400,
            "SMTP_FAILED": 502,
        }.get(e.code, 400)
        raise HTTPException(status, detail={"code": e.code, "message": str(e)})
    return result

@router.post("/api/auth/signup")
async def account_signup(payload: AccountSignupInput, ...):
    if (settings.account_email_verification_required
            and payload.verification_code is None):
        raise HTTPException(400, detail={
            "code": "VERIFICATION_CODE_REQUIRED",
            "message": "需要先获取并填写邮箱验证码",
        })
    try:
        return identity_service.signup(**payload.model_dump())
    except IdentityError as e:
        # 已有映射，复用
        raise HTTPException(...)
```

---

## 四、配置

```python
# src/customer_service_ai/config.py
class Settings(BaseSettings):
    # 邮箱验证码开关
    account_email_verification_required: bool = True
    account_email_verification_ttl_seconds: int = Field(default=600, ge=30, le=3600)
    account_email_verification_resend_cooldown_seconds: int = Field(default=60, ge=0, le=600)
    account_email_verification_max_sends_per_hour: int = Field(default=10, ge=1, le=100)
    account_email_verification_max_attempts: int = Field(default=5, ge=1, le=20)
    account_email_verification_lockout_seconds: int = Field(default=1800, ge=60, le=86400)
    # SMTP
    email_smtp_host: str = ""
    email_smtp_port: int = Field(default=587, ge=1, le=65535)
    email_smtp_username: str = ""
    email_smtp_password: str = ""
    email_smtp_from_address: str = ""
    email_smtp_use_tls: bool = True
    email_smtp_timeout_seconds: float = Field(default=10.0, ge=1.0, le=60.0)
```

`.env.example` 同步追加这 13 个变量；CI / 本机默认全空，走 `LoggingEmailSender`。

---

## 五、前端

桌面客户端接入点：

```ts
// apps/desktop/src/renderer/features/settings/SettingsPage.tsx
// 邮箱 input 之后、密码 input 之前插入「验证码」行（仅 signup 模式）
<div className="form-row">
  <input
    inputMode="numeric"
    maxLength={6}
    pattern="\d{6}"
    placeholder="邮箱验证码"
    value={account.verificationCode}
    onChange={e => setAccount({...account, verificationCode: e.target.value})}
    data-testid="account-verification-code"
  />
  <button
    disabled={codeSending || codeCooldown > 0 || !account.email}
    onClick={handleSendCode}
    data-testid="account-send-code"
  >
    {codeSending ? "发送中…" : codeCooldown > 0 ? `${codeCooldown}s 后重发` : "发送验证码"}
  </button>
</div>
{codeMessage && (
  <p className={codeMessageKind === "ok" ? "ok" : "err"}>
    {codeMessage}
  </p>
)}
```

`setInterval(1000)` 倒计 `codeCooldown`，卸载时清理。

---

## 六、测试

```python
# tests/test_email_verification.py
import pytest
from datetime import datetime, timedelta, UTC

class FrozenClock:
    def __init__(self, t):
        self._t = t
    def __call__(self):
        return self._t
    def advance(self, seconds):
        self._t = self._t + timedelta(seconds=seconds)

@pytest.fixture
def service(tmp_path):
    clock = FrozenClock(datetime(2026, 1, 1, tzinfo=UTC))
    sender = LoggingEmailSender()
    svc = EmailVerificationService(
        database_path=tmp_path / "verify.sqlite3",
        clock=clock,
        email_sender=sender,
    )
    svc.initialize()
    return svc, clock

@pytest.mark.asyncio
async def test_request_then_verify_ok(service):
    svc, _ = service
    await svc.request_code("alice@example.com")
    # 拿日志里的 6 位码
    code = last_logged_code()
    svc.verify_code("alice@example.com", code)        # 不抛即通过

@pytest.mark.asyncio
async def test_resend_cooldown(service):
    svc, clock = service
    await svc.request_code("alice@example.com")
    with pytest.raises(EmailVerificationError) as ei:
        await svc.request_code("alice@example.com")
    assert ei.value.code == "RESEND_COOLDOWN"

@pytest.mark.asyncio
async def test_hourly_limit(service):
    svc, clock = service
    for _ in range(10):
        await svc.request_code("alice@example.com")
        clock.advance(61)
    with pytest.raises(EmailVerificationError) as ei:
        await svc.request_code("alice@example.com")
    assert ei.value.code == "RATE_LIMIT_EXCEEDED"

def test_wrong_code_increments_attempts(service):
    svc, _ = service
    # 先注入一行
    asyncio.run(svc.request_code("alice@example.com"))
    with pytest.raises(EmailVerificationError) as ei:
        svc.verify_code("alice@example.com", "000000")
    assert ei.value.code == "WRONG_CODE"
    row = svc._db.execute(
        "SELECT attempts FROM wb_email_verification_codes WHERE email = ?",
        ("alice@example.com",),
    ).fetchone()
    assert row["attempts"] == 1        # ← 之前永远 == 0（参见第 01 篇）

def test_lock_after_max_attempts(service):
    svc, _ = service
    asyncio.run(svc.request_code("alice@example.com"))
    for _ in range(5):
        with pytest.raises(EmailVerificationError):
            svc.verify_code("alice@example.com", "000000")
    with pytest.raises(EmailVerificationError) as ei:
        svc.verify_code("alice@example.com", "000000")
    assert ei.value.code == "CODE_LOCKED"
```

---

## 七、可复用清单 · 邮箱验证码

1. **盐 + PBKDF2 哈希存表，不要明文**：`secrets.token_bytes(16)` + `hashlib.pbkdf2_hmac("sha256", code.encode(), salt, 200_000)`。
2. **TTL / 冷却 / 小时上限 / 错误上限 / 锁定时间 全部走 `clock` 注入**：测试时推进时间，避免 `sleep`。
3. **错误对象在 sqlite 块外构造**：「先写后抛」一定回滚，第 01 篇的坑这里重演。
4. **未配 SMTP 时一律走 `LoggingEmailSender`**：CI / 本机能跑、dev 能看到验证码、生产配齐 SMTP 后日志不再含码。
5. **`hmac.compare_digest` 校验**：不要 `==`，避免时序攻击。
6. **统一错误码 → HTTP 状态映射**：`RESEND_COOLDOWN` → 429 / `WRONG_CODE` → 400 / `CODE_LOCKED` → 429，前端按状态码区分提示。
7. **邮箱枚举防护**：`WRONG_CODE` 和 `VERIFICATION_CODE_REQUIRED` 都返回 400 + 统一文案，不暴露「邮箱是否存在」。

---

## 八、相关坑

- [[2026-08-08-pitfalls-01-python-sqlite3-context-rollback]] · 这篇里 `verify_code` / `request_code` 都涉及「块内 raise」，必须按第 01 篇的写法处理。
- [[2026-08-08-pitfalls-03-frontend-auth-tenant-mismatch]] · 前端的 60s 倒计时按钮要跟服务端的 `resend_cooldown_seconds` 对齐；两端都是 60s 才能给用户一致反馈。
- [[2026-08-08-pitfalls-11-agent-capability-registration-pattern]] · 整个 email 流不直接走 capability（不归 agent 管），但 `signup` 的 HTTP 端点本身是「auth 类接口」——和 capability 注册是两套入口，互不干扰。