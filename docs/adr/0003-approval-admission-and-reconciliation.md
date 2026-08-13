# ADR 0003: 承認指紋によるadmission、branch封印、reconciliation

- 状態: Accepted — 承認指紋、現在値の二重確認、branch作成時機、観測した変更でのfail-closed方針は決定済みである。
- 日付: 2026-08-13

## 背景

実装Jobは、人間がLinear IssueをTriageからTodoへ移して承認したWHAT（GitHub Issue）とHOW（Linear Issue）だけを実行する。webhookは重複、順不同、欠落、遅延を許容するため、通知またはlocal stateを承認の根拠にはできない。

承認後、workerを始めるまでに本文、title、関連付け、target branchが変わり得る。本文を別の正本として保存せずに、その実行がどのWHAT/HOW versionに束縛されるかをJob、lease、branch、外部操作へ一貫して渡す必要がある。[ADR 0002](./0002-job-ownership-and-execution-state.md)の承認revision tuple、Job identity、所有権、外部operation fencingのうち、この問題を置き換える範囲をこのADRで定める。

GitHubとLinearのnative historyは、provider間の完全な順序、本文変更の完全性、attachment relinkの全履歴を保証しない。本システムは悪意ある履歴改ざんへの耐性をv1の承認条件にせず、Todoになった後の現在値を所有権取得の前後で二度読み、一致した内容だけを実行対象として封印する。二回のread間で観測できない一時変更や、変更後に元の値へ戻った事実は検出しない。

## 決定

### 正本とapproval fingerprint

- GitHub IssueのtitleとbodyだけがWHATである。Linear IssueのtitleとdescriptionだけがHOWであり、LinearのTriage→Todo遷移だけが実行承認である。
- **approval fingerprint**は、seal時点で二度一致した現在のWHAT/HOWと対応するimmutable IDを束縛するversion tokenである。WHAT/HOWの正本、承認receipt、本文snapshot、または履歴の代替ではない。
- `serve`はfingerprintをJob identity、Job lease key、branch lock record、canonical branch名、external operation requestへ保存または送ってよい。title、body、description、history snapshot、またはそれらのcopyはこれらへ保存しない。
- native historyは診断と監査表示の補助情報として利用してよいが、取得可能性、完全性、順序をadmissionまたは外部操作の必須条件にしない。history IDとtimestampをJob identity、lease key、branch名、external operation requestへ入れない。
- `serve`はfingerprintを計算する一連のread中だけprovider文字列をmemoryに保持し、成功・失敗を問わずそのattemptの本文値を破棄する。fingerprintだけから本文を復元できるとは扱わない。

### canonical encoding

schema markerを`"oriel/approval-fingerprint/v1"`とする。`repository ID`は対象GitHub repositoryのimmutable node ID、`GitHub Issue node ID`は対象Issueのimmutable node ID、`Linear issue UUID`は対象Linear Issueの`id`である。全てをprovider APIが返したstringとして取得できなければadmitしない。

`body`または`description`がprovider APIで`null`または未設定なら空stringにする。それ以外の値はstringでなければadmitしない。titleはstringでなければadmitしない。Unicode正規化、trim、改行変換、case変換、HTML/Markdown変換、URL正規化、またはprovider文字列への他の変換は**行わない**。

次のJavaScript値を、この順序のまま`JSON.stringify`する。objectを使わないためproperty順序の余地はない。

```ts
[
  "oriel/approval-fingerprint/v1",
  repositoryId,
  githubIssueNodeId,
  githubTitle,
  githubBody ?? "",
  linearIssueUuid,
  linearTitle,
  linearDescription ?? "",
]
```

その`JSON.stringify`結果をUTF-8 bytesとしてSHA-256し、digestをlowercaseの64桁hexで表す。`JSON.stringify`またはUTF-8 encodingの失敗、非string input、SHA-256の失敗、または64桁lowercase hexでない結果ではfail closedする。このencodingとschema markerを変える変更は新しいADRとschema markerを要する。

### canonical branch

canonical branchは次である。

```text
oriel/<Linear identifier>-gh-<GitHub issue number>-<full digest>
```

`<full digest>`は上記64桁を省略しない。`<Linear identifier>`と`<GitHub issue number>`は人間がroutingするための表示部分だけであり、version bindingはdigestだけが担う。

Linear identifierは変換せず、`^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$`に一致しなければならない。GitHub issue numberは正の整数をleading zeroなしの10進表現にしたものとする。組み立てたbranch名はさらにGit実装の`check-ref-format --branch`に通らなければならない。いずれかを満たさない場合、置換・slug化・切り詰めはせずadmitしない。初回create前のidentifier変化はprospective branch名を変えるためそのattemptを停止してreconcileする。ただし同fingerprintのcanonical refが既に一意に存在する場合、routing部分のidentifier変化でrefをrenameまたは追加作成せず、その同じrefだけをadoption candidateとする。複数candidateまたは一意性を証明できない場合はfail closedする。

### admissionとbranch封印の順序

**seal**は、CASでcanonical branchを作った後に現在値を再読し、fingerprint、state、関連付け、baseが一致したと確認して初めて完了する。workerはsealより前には存在してはならない。通知を受けた、pollで変化を見つけた、または再起動した`serve`は、次の順序だけで実装workerを開始する。

1. 人間がLinear IssueをTriageからTodoへ移す。`serve`、Agent、relayはこの遷移を実行しない。relayは署名・認可済み通知をroutingするだけで、payload、本文、fingerprint、Job、履歴を正本として永続化しない。
2. `serve`はread-only reconciliationを行う。current Linear stateがTodoであること、current attachmentからGitHub Issueが一意に解決すること、current state、attachment tuple、GitHub/Linear title・本文、Linear identifier、target base refとそのOIDを読む。
3. 読んだ現在値からfingerprintとcanonical branch名を計算し、そのfingerprintを含むJob identityを導出する。Job identityをkeyに[ADR 0002](./0002-job-ownership-and-execution-state.md)のJob leaseを取得し、read-backでcurrent lease generationを確認する。
4. 同じ`claiming`中に、Workflow-wide replacement fenceのpre-lock確認を行った後、expected canonical branchをkeyとする**prospective branch lock**を取得する。branch refがまだ存在しない場合と同fingerprintのadoption candidateである場合のどちらでも、new Job identityとnew branch-lock generationが一致することをread-backしなければならない。lock取得またはread-backが失敗・結果不明ならworkerを開始しない。leaseを安全にreleaseできる場合だけ`pending`へ戻り、そうでなければ`interrupted`へ移る。
5. GitHubとLinearを再読し、step 2と同じstate、attachment tuple、WHAT/HOW、identifier、fingerprint、base ref/OID、およびcanonical refの存在/tipを再計算する。最初のreadからいずれかが変わった場合はbranchを作らずworkerを開始しない。保持する所有権を安全にreleaseし、下記の差し戻しを行う。
6. step 5でcanonical refが不存在なら、GitHub GraphQLの`updateRefs`を一回だけ呼び、target base refの不変とcanonical refの不存在を同じatomic updateの比較条件にする。`expectedBaseOid`をstep 5で確認したOID、`zeroOid`を40桁のzero OIDとして、`force: false`の二つの`RefUpdate`を渡す。

   ```text
   target base ref: beforeOid = expectedBaseOid, afterOid = expectedBaseOid
   canonical ref:   beforeOid = zeroOid,         afterOid = expectedBaseOid
   ```

   最初のno-op updateはbase refがそのOIDから変わっていないことだけを比較し、二番目はcanonical refが存在しないときだけbase OIDで作る。`updateRefs`は全updatesをatomicに処理し、一つでも拒否されればどちらのrefも変更されない。実装前contract testで、このGitHub App installation/tokenがno-op compareを受け付けることを確認しなければならない。未対応、権限不足、または結果不明なら、`createRef`、逐次更新、または別の弱いcreate APIへfallbackせずfail closedする。
7. initial createの`updateRefs`がtimeout、接続切断、または曖昧な応答なら成功として再送しない。target base refとcanonical refをread-backし、両方がexpected OIDでありcanonical ref名もexpected branch名に正確に一致することを確認してからだけ次へ進む。refが既に存在すると確定した場合は、下記のexisting same-fingerprint branch adoption flowだけへ進める。他の不一致、読取不能、または結果不明では`interrupted`へ移りworkerを開始しない。
8. initial createまたはexisting same-fingerprint branch adoptionの後、`serve`はGitHubとLinearをもう一度再読する。state、attachment tuple、WHAT/HOW、fingerprint、target base OID、branch名、current lease/branch-lock generationと下記のWorkflow-wide replacement fenceが一致するときだけworkerを開始する。

step 8で不一致または証明不能なら、workerを開始せず、branch lock、Job leaseの順にownershipをreleaseする。CAS create済みのbranchはactive canonical branchにしない。自動削除、上書き、または再利用はこのADRでは決めない。

### Workflow-wide replacement fence

fingerprintを持つJobがcanonical branchからworkerを開始する前に、`serve`は同じWorkflowの全remote Job lease、branch lock、およびcurrent external active canonical branch/Pull Request tupleをread-backする。異なるJob identityのcode-changing Jobについて、workerが停止済みであり、current Job leaseとbranch lockを持たず、releaseのread-backまたはexpiry後のreconciliationまで完了していることを確認しなければならない。同fingerprintの先行Jobを置き換える場合も同じであり、そのPull Requestはunmergedでclosed済みまたは不存在でなければならない。異なるactive canonical branch/Pull Request tupleも存在してはならない。旧branch refがGitに物理的に残るだけで、active tupleにもcurrent lockにも属さないならinactiveであり、この確認を妨げない。

異なるJobがcurrent ownershipを保持する、ownershipのrelease/takeover/write結果が不明である、または全remote recordを読めない場合、新Jobはworkerを開始しない。自分のownershipを安全にreleaseできるなら`pending`へ戻り、できなければ`interrupted`へ移る。旧Jobの停止確認より先にactive canonical branch/Pull Request tupleを新branchへ移動してはならない。

異なるfingerprintのattemptが並行しても、各attemptはseal後の現在値と自分のfingerprintが一致するときだけworkerを開始できる。したがって同じWorkflowでworkerを開始できるJob identityは高々一つである。二回のread間で変更後に元の値へ戻った場合は同じfingerprintとして扱い、その一時変更の検出は保証しない。

### 現在値の一致とTriageへの差し戻し

admissionと外部操作前の確認は、provider-native historyではなく現在値を使う。少なくとも次が先行read、所有権取得後のread、seal後のreadで一致しなければならない。

- Linear stateがTodoであること
- GitHub IssueとLinear Issueのimmutable ID、現在のattachment relation
- GitHub/Linearのtitleと本文から計算したfingerprint
- target base refとOID、canonical branch、current lease/branch-lock generation

一致しなければ`serve`はworkerを開始せず、running中なら新しい外部操作を拒否してworkerを停止する。`serve`はcurrent Job leaseと対象Workflowを再確認してからLinear IssueをTodoからTriageへ戻し、人間のfresh Triage→Todoを待つ。この差し戻しは承認ではなく、無効になった承認状態の機械的な反映である。relay、Agent、harnessは差し戻しを実行しない。

差し戻しの送信結果が不明なら盲目的に再送せず、Jobを`interrupted`として現在のLinear stateとoperation recordを再調停する。差し戻しwriteのidempotencyと結果判定の詳細は別途定義する。

native historyはこの一致判定の入力にしない。履歴の欠落、group化、provider間の順序不明だけを理由にautomatic admissionを無効化しない。履歴が完全でない理由と許容するraceは[approval history capability調査](../research/approval-history-capabilities.md)に記録する。

### 初回branch作成、existing same-fingerprint branch adoption、再承認

fingerprintが変わればcanonical branch名も変わり、step 6のinitial create flowだけが候補である。fresh Triage→Todoでもfingerprintが同じなら同じ論理Jobとcanonical branchを再利用する候補になる。新しい実行attemptは新しいlease generationで区別する。

canonical refが不存在ならinitial create flowを使う。refが既に存在する場合、refの存在だけでadmissionを成功または失敗と決めず、**existing same-fingerprint branch adoption flow**へ分岐する。新JobはWorkflow-wide replacement fenceにより先行workerの停止、lease/lockのreleaseまたはexpiry後reconciliation、active PRの不存在またはunmerged closeを確認した後、自身のJob identityでcanonical branch lockを新generationとして取得する。existing refをforce push、reset、上書きしてはならない。

adoptionは、trusted `serve`のoperation recordとcurrent Git stateから、existing tipが先行する同fingerprint Jobの安全なcheckpointまたは既知のexternal writeであることをoperation-specific reconciliationが証明できる場合だけ許可する。証明不能、operation result不明、またはcurrent Git state不一致ならfail closedしworkerを開始しない。このbranch takeover/reconciliation protocolの詳細は未解決である。

matching nonterminal Jobなら通常のresumeだけが候補であり、このADRとADR 0002の現在値確認とfencingを満たさなければならない。terminal、cancelled、またはunmergedでclosedになったPull Requestの後でも、fresh Triage→Todoが同fingerprintなら上記adoption、fingerprintが変わればnew branchによってのみautomatic admissionを試みる。

running中またはresume前にstate、attachment tuple、またはapproval fingerprintの不一致を観測したら、旧workerを停止し、旧Jobは新しいexternal operationを開始しない。`serve`は上記の手順でTriageへ戻す。fingerprint変化を伴うWHAT/HOW変更では、fresh Triage→Todoの後に新Jobと新canonical branchを導出する。

### external operation fencing

approval fingerprintを伴う外部operation requestは、[ADR 0002](./0002-job-ownership-and-execution-state.md)で定めるJob identity、target、lease generation、必要なbranch-lock generation、idempotency keyに加え、そのfingerprintを含む。外部操作の直前に`serve`はcurrent state、attachment tuple、対象Issue IDs、current fingerprint、canonical branch/PR tuple、lease/lock generationを再調停し、全てがrequestと一致するときだけwriteする。一致判定が不合格・不明ならwriteを拒否して旧workerを停止し、上記の手順でTriageへ戻す。

履歴IDとtimestampをrequestへ入れてはならない。provider APIはlease fencingをatomicな書込み前提条件として受け付けないため、timeout、crash、所有権喪失、またはwrite結果不明では盲目的に再試行せず、ADR 0002に従い`interrupted`としてoperationごとのreconciliationまで停止する。

## 帰結

- branchはTodo承認後かつworker開始前にだけCASで作られる。full digestにより、human-readable routing部分が変わってもversion bindingを取り違えない。
- digestを「どこにも置かない」という以前の結論は撤回する。fingerprintは必要なversion bindingとして保存するが、本文や履歴を第二の正本へ複製しない。
- native historyの完全性は要求しないため、二回のread間で観測できない一時変更や元の値への差し戻しを検出できない。v1はこのraceを受け入れ、観測した不一致だけをfail closedにする。

## 対象外

- Issue/Linear対話、comment、本文更新
- Triageへの機械的な差し戻しwriteのidempotency key、条件付き更新、結果不明時の個別reconciliation
- Pull Request、Git push、checkpoint、PR review、required checkの個別reconciliation
- lease refの保存形式、TTL、heartbeat、takeover猶予
- device登録、OAuth、webhook署名、relay認可
- staleまたはinactive branchの自動削除方針
- existing same-fingerprint branch adoptionのcheckpoint/known-write証明とoperation-specific takeover/reconciliation protocol

## 実装前の検証

automatic admissionを実装または有効化する前に、対象repositoryとLinear workspaceで、現在値の取得、二重read、fingerprint一致、Todo→Triage差し戻し、GitHub App installation tokenによるatomic `updateRefs`をcontract testする。native historyの完全性は合格条件に含めない。
