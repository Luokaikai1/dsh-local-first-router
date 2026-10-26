# dsh-ollama-kaiyuanjl

一个 DeepSeek Harness（DSH）插件：**先跑本地 Ollama 模型，第一次启动会询问要不要扩展上下文；本地不行才自动走云端兜底**，并且云端只在谷期、额度够、且你允许付费时才会用。

> A DSH plugin that runs a local Ollama model first, asks once whether to widen its context, and only falls back to the cloud when the local route is stuck — gated by off-peak hours, remaining credits, and your consent.

## 它做什么

三层路由：

| 层 | 默认 | 用途 |
|---|---|---|
| 执行体 | `qwen2.5:7b-24k` | 新会话的所有常规任务与工具调用 |
| 顾问 | `deepseek-r1:8b-8k` | 数学/逻辑/证明类难题出思路（通过 `consult_advisor`） |
| 云端兜底 | `deepseek-flash` → 可配置兜底（如 GLM） | 本地卡住或上下文超窗时，按额度策略升级 |

关键行为：

- **本地优先**：新会话默认落在本地执行体；手动选过别的模型的会话不会被强切。
- **上下文守卫**：会话 token 超过 `localContextTokens - contextReserveTokens` 时不再往本地切；本地会话会升级云端，老会话保持原路由（guard 模式）。
- **升级触发**：本地报错、工具失败 ≥ N、重复调用、步数 ≥ M、上下文超窗。
- **云端闸门**：谷期（工作日 09:00–12:00、14:00–18:00 之外，周末/法定节假日全天）+ 余额门槛。
- **额度策略**：优先用 DeepSeek 赠送余额；赠送不足时询问是否用付费余额；可配置兜底 provider（云端失败自动切）。
- **首次启动**：会注入一条提示，让 agent 询问你是否开启“自动上下文扩展”（自动创建 `<base>-<ctx>k` 模型变体）。
- **全部本地**：插件本身不联网（除你配置的 Ollama / 云端 provider），日志与状态都在 `~/.dsh/` 下。

## 工具

| 工具 | 作用 |
|---|---|
| `consult_advisor` | 向本地推理顾问请教思路（只返回文字，不执行工具） |
| `model_quota` | 展示当前接入的模型、上下文窗口、赠送/充值余额、峰谷、兜底配置 |
| `set_cloud_policy` | 允许/禁止付费余额、切换兜底、可持久化 |

`model_quota` 示例输出：

```
本地执行: local-ollama/qwen2.5:7b-24k (24576 ctx)
本地顾问: deepseek-r1:8b-8k
云端主用: deepseek-account/deepseek-flash  赠送余额 2.40 元 / 充值余额 0 元
云端兜底: zhipu-glm/glm-5.3-flash  (额度未知，按错误或询问切换)
峰谷: 谷时  付费余额使用: 需确认
```

## 安装

```bash
dsh plugin --profile <profile> add github:<owner>/dsh-ollama-kaiyuanjl
```

或本地目录：

```bash
dsh plugin --profile <profile> add file:<path-to-this-repo>
```

安装后在该 profile 的 `cordis.patch.yml` 里配置（示例，不含任何密钥）：

```yaml
- id: local-first-router
  config:
    localProvider: local-ollama
    localModel: qwen2.5:7b-24k
    localBaseModel: qwen2.5:7b
    localContextTokens: 24576
    contextReserveTokens: 1024
    autoContextExpansion: true
    manageExistingSessions: true
    cloudProvider: deepseek-account
    cloudModel: deepseek-flash
    fallbackProvider: zhipu-glm
    fallbackModel: glm-5.3-flash
    requireOffPeak: true
    minBonusCny: 1
    minPaidCny: 1
    askBeforePaid: true
    advisorModel: deepseek-r1:8b-8k
```

同时把本地 provider 加进 `llm-pi-ai`：

```yaml
- id: llm-pi-ai
  config:
    providers:
      local-ollama:
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1
        apiKeyEnv: LOCAL_OLLAMA_API_KEY
        headers:
          authorization: Bearer ollama
        models:
          - id: qwen2.5:7b-24k
            contextWindow: 24576
          - id: deepseek-r1:8b-8k
            contextWindow: 8192
```

云端 provider（DeepSeek 账户、智谱等）用 DSH 自带的「设置 → 模型」接入即可；**密钥由 DSH 凭据系统保存，插件不读取也不写入任何密钥**。

## 聊天会话默认本地（QQ 等）

按会话 id 前缀识别聊天会话，默认只走本地；需要云端兜底时必须先征得用户同意：

```yaml
- id: local-first-router
  config:
    localSessionPrefixes:
      - onebot-group-
    chatCloudApproval: true    # 云端兜底需用户批准
```

- 命中前缀的会话默认本地，不自动升级。
- 触发升级时插件会注入一条询问，用户同意后调用
  `set_cloud_policy(allowCloud=true, scope=turn)` 才允许本轮云端兜底。
- 手动切换到云端模型视为用户已同意，插件不拦截。
- 工作/编码会话不受影响，仍按“本地优先，卡住才升级”的策略走。

### 人设防丢（长会话截断）

本地窗口小于会话长度时，Ollama 会**从开头截断**，把系统提示连同人格一起切掉。配置一条近端提醒即可：

```yaml
forceLocalPersonaReminder: '【人设】你是……，回复 1-3 句、口语化、不用 Markdown。'
```

上下文超过本地窗口 70% 时，插件会在本轮末尾补发这条提醒，保证截断后模型仍能看到人设。长聊仍建议定期 `/new` 或压缩，避免细节丢失。

## 本地上下文

Ollama 默认 `num_ctx` 往往只有 4096，而 DSH 的系统提示 + 工具定义就可能到 9k，直接截断。插件提供两种处理：

1. `autoContextExpansion: true`：启动时检测 `localModel`，不存在就用 `/api/create` 按 `localContextTokens` 创建派生模型；
2. 手动创建：

```text
FROM qwen2.5:7b
PARAMETER num_ctx 24576
```

8GB 显存的经验值：16k 约 5.5GB、24k 约 6.0GB（均可 100% GPU）；32k 会溢出到 CPU 且只剩约 0.7GB 显存，不建议。请按自己的显存调整 `localContextTokens`。

## 数据与日志

- 决策日志：`~/.dsh/logs/local-first-router.jsonl`
- 首次启动/付费策略状态：`~/.dsh/local-first-router/state.json`
- 本地模型对话不会上传到云端；云端调用只在你配置的 provider 上发生。

## 已知限制

- 没有图形化额度面板（用 `model_quota` 工具展示）。
- 上下文将满时不会自动 `/compact`；目前是提示你先压缩再切（自动总结需要确认，避免意外改写历史）。
- 顾问模型不支持工具调用，只作为“出思路”的第二意见。

## License

MIT，见 [LICENSE](LICENSE)。
