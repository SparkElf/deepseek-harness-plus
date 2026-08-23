# 使用 GitHub App 重建作者无法自审的 Pull Request

[English](recreating-author-blocked-prs-with-a-github-app.md) | 中文

当开放PR的作者正是必须审批它的管理员时，使用本流程。GitHub不允许PR作者批准自己的PR。

## 前置条件

- 管理员是相关CODEOWNER。
- GitHub App只安装到目标仓库。
- App拥有Contents读写、Pull requests读写和Metadata只读权限。
- 私钥保存在仓库之外，文件权限为600。
- 工作树干净，流程不会合并目标分支。

不要把私钥、JWT、Installation Token或PAT放入聊天、shell历史、仓库文件或PR正文。

## 创建App Token

在本机设置GH_APP_ID和GH_APP_KEY。使用App私钥生成短期JWT，再通过GitHub App installations access-token接口交换Installation Token。两个值只保存在shell变量中，不要打印。

使用安全的仓库读取验证安装：

    GH_TOKEN="$GH_APP_TOKEN" gh api repos/<owner>/<repo> --jq '{full_name,default_branch}'

## 迁移一个PR

在修改前保存源PR的标题、正文、headRefOid和baseRefName。

通过Git references REST接口，将唯一机器人分支指向完全相同的源head提交：

    bot/migrate/pr-<old-number> -> <headRefOid>

使用原来的base分支、标题和正文创建替代PR，head使用机器人分支。确认替代PR存在后才关闭源PR。

关闭源PR时写入替代PR编号，然后切回管理员的普通gh登录并批准替代PR：

    gh pr review <new-number> --repo <owner>/<repo> --approve

不要在此流程中使用管理员bypass。审批和合并是两个不同动作；本流程不会合并master。

## 迁移PR Stack

在修改任何PR前盘点所有开放PR。按Stack从最低层向上处理。每个PR保留原来的base分支，即使base也是Stack中的另一个分支。每个源PR使用唯一机器人分支。

先创建并验证替代PR，再关闭源PR。如果网络操作超时，先读取GitHub当前状态再重试，不能盲目创建重复PR。

## 验证

源PR必须是CLOSED，替代PR必须由App创建并获得管理员审批。每一对PR都要比较head SHA、base分支、标题、正文、替代PR作者和审批状态。

已经Merged或已经Closed的历史PR是不可变记录，不参与迁移。删除源分支不会删除PR记录。最终检查必须确认迁移命令没有合并master。
