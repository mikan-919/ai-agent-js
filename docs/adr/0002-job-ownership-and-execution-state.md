# ADR 0002: Jobの所有権と実行状態

- 状態: Accepted
- 日付: 2026-08-12

## 背景

複数の`serve`が同じWorkflowを観測でき、workerまたは`serve`は途中で失われる。外部のWHAT、HOW、承認、Pull Requestの現在状態をローカルの実行状態で複製せず、一つのJobを誰が実行してよいかと、停止・引き継ぎを決める必要がある。

## 用語

- **Workflow**: GitHub Issueで識別される長期の仕事。GitHub Issue、対応するLinear issue、activeなcanonical branchとPull Request、Jobを結び付ける。
- **Job**: Workflow内の一回の実行。identityは実行中に不変で、workerを失っても同じJobを別workerが再開できる。
- **worker**: Jobを実行する一回のharness process attempt。workerはJobのidentityでも所有者でもない。workerが失われた後も、supervising `serve`が再調停とlease取得をしてから、replacement workerで同じJobを再開できる。
- **canonical branch**: Workflowのコード変更に使う唯一のactive branch。activeなcanonical branchとPull RequestはWorkflowごとに高々一つである。

この用語はADR 0001の「TaskとJobは同義」という記述を置き換える。`Task`はこのADR以後、WorkflowまたはJobの別名として使わない。

## Job identityと重複排除

Job identityは、repository identity、Workflow identity、Job kind、stableな外部trigger/input key、および承認に基づき実行するJobでは承認済みWHAT/HOW revision tupleを決定的に組み合わせる。この構造はleaseのkeyにも使う。重複、順不同、または別`serve`で受信した同じ外部通知は、同じJob identityとleaseへ対応付けなければならない。

nonterminalなJobへ明示的にcorrelateされたfollow-upは、そのJobを再開する。異なるtrigger/input、またはterminal state後の新しい承認revisionは、新しいJobを作る。これらの構成要素のencoding、wire表現、providerごとのtrigger/input keyの対応付けは、event/reconciliation ADRで決める。

## 外部phaseとlocal実行状態

GitHub Issue、Linear issue、Pull Requestの現在状態は外部から導出するWorkflowのphaseであり、local Job stateに保存して正本を複製しない。webhookはphase変更の通知にすぎず、重複・順不同・欠落を許容する。

localに保存するJob execution stateは次だけとする。これはlocal runtimeの処理位置を表すための最小状態であり、Workflow phaseのcacheではない。

| State | 意味 | 許可される次のstate |
| --- | --- | --- |
| `pending` | 実行候補として作られたが、leaseを得ていない。 | `claiming`, `cancelled` |
| `claiming` | 現在の外部phaseを再確認し、Job leaseと必要なbranch lockの取得結果を確定している。 | `running`, `pending`, `interrupted` |
| `running` | supervising `serve`がcurrent Job leaseと、コード変更Jobではcurrent branch lockを持ち、workerが許可された作業を実行できる。 | `stopping`, `interrupted` |
| `stopping` | 制御された完了または取消のためにworkerを止め、所有権を返却している。新しい外部操作は開始しない。 | `completed`, `cancelled`, `interrupted` |
| `interrupted` | worker crash、leaseまたは必要なlockの喪失、renewal結果不明、takeover、または外部操作の結果不明で、再調停が必要である。 | `claiming`, `completed`, `cancelled` |
| `completed` | Jobの目的を完了し、worker、lease、必要なbranch lockを持たない終端状態。 | — |
| `cancelled` | Jobを継続しないと決め、worker、lease、必要なbranch lockを持たない終端状態。 | — |

イベントと遷移は次に限る。ここでいう「結果不明」は、外部writeを送ったか、または送ったwriteが反映されたかを確定できない状態をいう。

| From | Event / guard | To | 必要な結果 |
| --- | --- | --- | --- |
| `pending` | `claim_started` | `claiming` | 現在の外部phase、対象、承認revisionを読んでからlease取得を試みる。 |
| `pending` | `cancellation_requested` | `cancelled` | workerもleaseも開始しない。 |
| `claiming` | `claim_confirmed` | `running` | 対話Jobはcurrent lease generation、コード変更Jobはcurrent lease generationとcurrent branch-lock generation、およびactive branch/PR tupleを読み返して確認し、その後にworkerを開始する。 |
| `claiming` | `lease_unavailable` | `pending` | 未失効の他ownerを確認し、workerを開始しない。 |
| `claiming` | `claim_result_unknown` | `interrupted` | 取得結果を再調停するまで外部操作をしない。 |
| `claiming` | `required_lock_unavailable` | `pending` | code-changing JobはJob leaseを確認してreleaseしてから、workerを開始せずに戻る。 |
| `claiming` | `lock_or_release_result_unknown` | `interrupted` | lockの取得またはこの段階のlease releaseの結果を再調停するまで、workerを開始しない。 |
| `running` | `stop_requested` または承認revision不一致 | `stopping` | 新しい外部操作を止め、workerを終了して所有権を返却または失効待ちにする。 |
| `running` | `worker_lost`、leaseまたは必要なlockの喪失、takeover観測、または外部操作の結果不明 | `interrupted` | そのworkerの外部操作を止め、再調停を要求する。 |
| `stopping` | `completion_reconciled` | `completed` | branch lock、Job leaseの順で返却済み、または保持していないことを確認する。 |
| `stopping` | `cancellation_reconciled` | `cancelled` | branch lock、Job leaseの順で返却済み、または保持していないことを確認する。 |
| `stopping` | `lock_or_lease_release_result_unknown` | `interrupted` | workerを止めたまま、release結果を再調停する。 |
| `interrupted` | `reconciliation_allows_resume` | `claiming` | 同じJobについて現在の外部状態を再構成し、leaseを取り直す。 |
| `interrupted` | `completion_reconciled` | `completed` | 現在の外部状態がJobの成功を証明し、current Job leaseと必要なbranch lockを保持していないことを確認する。 |
| `interrupted` | `cancellation_reconciled` | `cancelled` | workerを持たず、既知の所有権を返却または失効待ちにする。 |

`interrupted`のreplacement workerは新しいJobを作らない。`serve`が外部の現在状態を再調停してから同じJobのleaseを再取得し、そのworkerを開始する。local DBを失った場合も、外部からstableなJob identityを再構成できる場合に限り、外部状態とremote leaseから同じ判断を再構成する。

## Job lease

すべてのJobは、実行中にJob leaseを一つだけ持つ。lease recordは少なくともJob identity、`serve` owner identity、expiry、取得ごとに新しいlease generationからなるfencing tokenを持つ。recordを置くremote Git refの形式、Job identityの構成要素のencoding、providerごとのstable trigger/input keyの対応付け、TTLとheartbeat間隔はここでは決めない。

取得・更新・引き継ぎは次の順序にする。

1. `serve`はGitHub、Linear、Gitから現在のWorkflow phase、対象、承認revisionを再構成する。実行不能ならleaseを取得しない。
2. `pending`または`interrupted`のJobは、未所有または失効済みのleaseだけを条件付きに取得し、新しいlease generationを記録する。成功を読み返してcurrent generationを確認するまで`claiming`のままとする。コード変更Jobは同じ`claiming`中にbranch lockを取得し、active canonical branch/Pull Request tupleを再確認する。両方を確認するまでworkerを開始しない。
3. ownerはcurrent lease generationと、必要な場合はcurrent branch-lock generationを比較条件にrenewする。renewalの失敗、期限切れ、別generationの観測、またはrenewal結果不明は直ちに`interrupted`とし、workerを止める。
4. takeoverは、leaseが失効済みであることを再確認した別`serve`だけが新generationで取得する操作である。旧workerの切断だけではtakeoverしない。
5. 完了または取消時は新しい外部操作を止め、保持するbranch lockを先に、次にcurrent lease generationを比較条件にJob leaseをreleaseする。いずれのreleaseも不能ならworkerは終了し、lease/lockのexpiryまたは後続のreconciliationへ委ねる。

対話JobはJob leaseだけを必要とする。実装JobとPR対応Jobは、Job leaseに加えてbranch lockを必要とする。

## Branch lock

branch lockはrepositoryとcanonical branchをkeyにする。Workflow全体やIssue/Linear対話Jobをlockしない。コードを変更する実装JobとPR対応Jobだけが、`claiming`中にcurrent Job leaseを確認してからcanonical branch lockを条件付きに取得し、取得後にWorkflowのactive canonical branch/Pull Request tupleがなお一致することを確認する。lock取得に失敗した場合はコード変更もworker開始もしない。Job leaseを確認してreleaseできた場合だけ`pending`へ戻り、lockまたはreleaseの結果が不明なら`interrupted`へ移る。

lock recordは少なくともcanonical branch、Job identity、Job lease generation、取得ごとに新しいbranch-lock generation、expiryを持つ。heartbeatとreleaseはcurrent lease generationとcurrent branch-lock generationの両方を比較条件にする。コードを変更するJobがleaseまたはlockを失った場合は`interrupted`へ移り、workerを止め、push、branch操作、Pull Request作成・更新を開始しない。release順序はbranch lock、Job leaseとする。

branch lockのtakeoverまたはreplacementは、current Job lease ownerだけが行える。ownerはlockが不在、またはexpiry済みであることを確認した場合だけCASで取得し、新しいbranch-lock generationを記録する。取得後はcanonical branch、Job identity、current lease generation、current branch-lock generationを読み返して確認する。workerのdisconnectだけではlockのtakeoverまたはreplacementを許可しない。同じcurrent Job lease ownerがreplacement workerを開始する場合も、既存lockのcurrent generationを読み返して確認する。lock取得または読み返しの結果が不明なら`interrupted`へ移り、workerを開始しない。

所有権の取得順序はJob lease、branch lock、active canonical branch/Pull Request tupleの再確認とする。tupleは取得後の妥当性確認であり、返却する所有権ではない。完了または取消時に返却する順序はbranch lock、Job leaseとする。

## 外部操作のfencingとreconciliation

`serve`だけが外部操作を実行する。外部操作requestはJob identity、operation種別、target、lease generation、必要ならbranch-lock generation、承認revision、idempotency keyを含む。idempotency keyは`serve`がdispatch前に永続的なoperation recordへ割り当て、同じ論理操作の再送で変えない。各操作の直前に、`serve`は次を全て確認する。

1. Jobが`running`で、requestのowner identityとcurrent lease generationが現在のJob leaseに一致する。
2. 現在のWorkflow phaseから導出したJob identity、Job種別、許可された操作、対象GitHub IssueとLinear issueがrequestと一致する。
3. 承認されたWHAT/HOW revisionがrequestと一致する。
4. idempotency keyがこのJobと論理操作に対応し、completeまたは結果不明として記録済みでない。
5. branchまたはPull Requestを変更する操作では、requestのcurrent branch-lock generation、canonical branch、active Pull Request tupleが現在のlockとWorkflowに一致する。

lease generationとbranch-lock generationは、より新しいownerを観測した`serve`が古いworkerの新規requestを拒否するためのfencing tokenである。しかしGitHub、Linear、remote Gitの外部APIは、このハーネスのlease fencingをatomicな書込み前提条件として強制しない。preflight後にleaseを失う、または既に送信したwriteがtakeover後に成功するraceを、generationだけで防ぐことはできない。

そのため、`serve`はpreflight直後に操作を送信し、operationごとに条件付き更新、providerが受け取るidempotency key、または観測可能な結果によるreconciliationを用いる。timeout、crash、所有権喪失により結果が不明なwriteは`interrupted`としてfail closedにし、盲目的に再試行しない。次のworkerはGitHub、Linear、Gitの現在状態を読んで既に反映済みかを判定し、操作固有の安全な続行方法が定義されるまで停止する。各external operationのconditional/idempotent protocolとreconciliationは別のADRで定める。

## crashと重複通知の不変条件

- webhook、poll、retryはJob開始の許可ではない。同じ通知を何度受けても、同一Jobのcurrent leaseを持つ`serve`に監督されていないworkerは実行も外部writeもできない。
- `serve`またはworkerのcrashはleaseの明示releaseを必要としない。heartbeat停止後、別`serve`はexpiryとcurrent external stateを確認してからtakeoverできる。
- 外部phase、承認revision、branch/PR tupleが変わった場合、旧workerは停止し、旧Jobを継続してwriteしない。必要なら外部phaseから新しいJobを作る。
- active canonical branchとPull RequestはWorkflowごとに高々一つであり、同じbranchを変更する二つのcode-changing Jobは同時にcurrent branch lockを持てない。

## 保留事項

- remote lease refの形式、Job identityの構成要素のencoding、providerごとのstable trigger/input keyの対応付け、lease TTL、heartbeat間隔、takeover猶予
- WHAT/HOW revisionの表現、取得、比較
- GitHub、Linear、Gitの各操作に対するconditional update、idempotency key、結果不明時のreconciliation手順
- concurrency、retry、checkpoint、timeout、resource limitの運用値
