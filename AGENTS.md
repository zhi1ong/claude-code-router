# Fork 工作约定

- `main` 仅用于同步上游；新功能分支从最新 `main` 创建，使用 `feat/` 前缀。
- 当前集成目标为 `feat/integration-rebuild`，以用户后续指令为准。各功能组的变更与修复先在对应分支提交、验证，再合入集成并同步远端；保留清晰的功能提交历史。
- 集成专属约定直接维护在集成分支。上游 PR 使用对应的独立功能分支，检查差异中没有混入其他功能或 fork 专属文件。

| 功能组 | 分支 |
| --- | --- |
| 百炼增强 | `feat/bailian-enhancements-v2` |
| Claude 默认模型列表、Anthropic effort 兼容 | `feat/claude-default-model-list-v2` |
| API Key/Profile 关联、日志与 Usage 归因 | `feat/profile-logs-v2` |
| 网页管理令牌认证 | `feat/web-management-token-login` |

- 开工先检查当前分支、`git status` 和 `git worktree list`。优先复用合适的 checkout，需要隔离时才创建 worktree，避免留下多份未提交改动。
- 实现以当前明确需求为界，优先复用现有路由、凭据池和存储机制；避免为假想扩展增加抽象层、框架、状态或配置项。
- 测试围绕可观察行为和真实回归，覆盖关键正常与故障路径；优先扩充现有用例、复用 fixture、合并等价场景，跨层测试只补独有的集成风险，避免镜像实现的重复断言。
- 按改动风险运行必要检查，合并后验证关键交互；通过后不无故重复全量测试。报告验证范围、已核实的基线失败及未执行项。
- 删除分支前确认提交已保存到目标分支；清理 worktree 前检查已跟踪、未跟踪和忽略文件，保留用户改动及非临时产物。
- macOS 路径按大小写不敏感处理，目录重组优先 `git mv`；删除或 `git clean` 前先列出目标内容，禁止删除刚接收移动文件的目录。
