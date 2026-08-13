# 承認からsealまでのnative historyを検証する capability 調査

調査更新日: 2026-08-13

## 結論

[ADR 0003](../adr/0003-approval-admission-and-reconciliation.md)は、current GitHub IssueとLinear Issueから決定的に計算したapproval fingerprintを、seal後のJob、lease、canonical branch、外部operationの**version binding**として使う。fingerprintは「Todoへ移した瞬間の本文」を証明するものではなく、WHAT/HOWの正本でもない。本文、title、description、履歴、またはsnapshotを別の正本へ保存しない方針は維持する。

content fingerprintとは別に、current Linear Todo episodeのnative immutableな`IssueHistory.id`をapproval episode keyとしてJob identityとlease keyへ入れる。これはLinear正本eventへのopaque pointerであり、本文/revision copyではない。したがって同一contentへのfresh Triage→Todoも新Jobを識別できる。一方、episode keyはbranch名とfingerprintへ入れず、同fingerprint Jobの既存branch adoptionは別途Git/operation reconciliationで安全性を証明できる場合だけ許可する。

人間のTodo承認がそのsealしたversionを承認したといえるためには、Todo承認からsealまでのstate、attachment relation、GitHub/Linearのtitle・本文について、native historyの完全性と順序を証明しなければならない。webhookは起床通知であり、この証明を置き換えない。

現行の公開契約と一回の実API観測には、その完全性を普遍的に保証する根拠がない。provider contractまたは当該repositoryの現在の観測でhistory gateを証明できないとき、automatic admissionは**無効**であり、`serve`はJob、lease、branch、workerを開始しない。人間の再承認を待つ。一回のcapability testの合格は、この結論を全repository、全workspace、全時点へ一般化しない。

以前の「digestをどこにも置かない」という結論は撤回する。ADR 0003が定めるfingerprintはversion bindingとして保存してよい。ただしfingerprintから本文を復元できるとは扱わず、本文やhistoryをreceiptとして複製しない。

## 現在確認できるprovider surface

### GitHub Issue

- GitHub GraphQLの`Issue.lastEditedAt`は最後の編集時刻であり、`Issue.userContentEdits`はcursor paginationを持つ編集connectionである。[GitHub GraphQL Issue reference](https://docs.github.com/en/graphql/reference/issues)
- `UserContentEdit`にはimmutableな`id`と`editedAt`がある。一方、公開schemaの`diff`は変更summaryであり、過去のIssue title/bodyそのものを返すfieldを示さない。connectionに順序指定もない。[GitHub GraphQL UserContentEdit reference](https://docs.github.com/en/graphql/reference/users)
- このsurfaceは「現在のIssueがいつ編集されたか」の手掛かりになるが、Todo承認とのcross-provider順序、履歴retention、全title/body変更との一対一対応、または過去本文の再構成を契約しない。`lastEditedAt`や`editedAt`の単純比較はhistory gateの証明に使えない。
- GitHub webhookは発生順のdeliveryを保証せず、遅延または未達があり得る。[GitHub webhook troubleshooting](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks) [GitHub failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)

### GitHub Git ref

- GitHub GraphQLの`updateRefs`は複数のref updateをatomicに実行する。`beforeOid`は現在OIDの比較条件であり、40桁のzero OIDはref不存在の比較に使える。[GitHub GraphQL Git reference](https://docs.github.com/en/graphql/reference/git)
- ADR 0003のbranch sealは、target base refの`beforeOid = afterOid = expectedBaseOid`というno-op compareと、canonical refの`beforeOid = zeroOid`、`afterOid = expectedBaseOid`を同一の`updateRefs`へ渡す。このno-op compareをGitHubがApp installation/tokenで受け付けるかは、実装前にcontract testする必要がある。未対応または結果不明なら、逐次ref createや別APIへfallbackせずautomatic admissionをfail closedする。

### Linear Issue

- Linearのdata-change webhookには現在の`data`、`updatedFrom`、action時刻、delivery UUIDなどがあるが、payloadは通知であり履歴の正本ではない。失敗deliveryは最大3回retryされる。[Linear Webhooks](https://linear.app/developers/webhooks)
- LinearのGraphQL endpointはintrospectionをサポートし、connectionはRelay形式のcursor paginationを使う。[Linear GraphQL API](https://linear.app/developers/graphql) [Linear Pagination](https://linear.app/developers/pagination)
- Linear公式GraphQL docsは、Issue作成から最初の3分に行われたIssue property変更をcreation processの一部として扱い、Issue changeとしてactivity logへ追加しないと説明する。[Linear GraphQL API](https://linear.app/developers/graphql) したがって、Todo承認からsealまでの区間がIssue作成から3分以内の時間帯と重なる場合、history gateは必ず不合格とする。3分を過ぎたことだけでは、履歴の完全性を証明しない。
- 2026-08-12の同endpointのintrospectionでは、`Issue`に`description`、`state`、`attachments`、`history`があり、`IssueHistory`に`id`、`createdAt`、`updatedDescription`、`descriptionUpdatedBy`、`fromStateId`、`toStateId`があった。これはその時点のschema可視性の観測であり、全description/title/attachment変更が完全に保持され、順序付けられるというprovider契約ではない。
- Linear APIはversion固定ではなく、schemaはdeprecationを通じて変わり得る。[Linear API deprecations](https://linear.app/developers/deprecations)

## 証拠のgap

- **cross-provider history**: LinearのTodo遷移とGitHubの編集について、同じclock上の完全な全順序または因果順序を公開契約から得られない。時刻文字列の比較だけでは承認後編集を否定できない。
- **attachment relink**: current attachmentのID/URLから現在の対応は読めても、承認時点からsealまで同じGitHub Issueを指していたこと、relinkがなかったこと、またはrelink履歴が完全であることを公開surfaceだけからは導けない。
- **Linear creation windowとhistoryのgrouping/omission**: 公式GraphQL docsは作成から最初の3分のIssue property変更をactivity logへ追加しない。よってTodo承認からsealまでがこのwindowと重なるcandidateは、観測の成否にかかわらずhistory gateを必ず失格にする。window外でも、`updatedDescription`とstate IDsの存在は各title/description/attachment操作との一対一対応を示さず、group化・omission・完全性は別途証明を要する。
- **paginationと可視性**: cursorをpage終端まで辿れたことは、そのtokenが見える範囲を読めたことを示すだけである。retention、権限で隠れたrecord、rate limit/partial error、移行、schema変更後にも承認区間が完全である保証にはならない。

これらのgapはfingerprintで埋めない。fingerprintはseal時のcurrent valueを束縛するだけであり、historyが示せない承認時点の内容を遡及して承認済みにしない。

## repositoryごとの capability / contract gate

automatic admissionを有効にする候補ごとに、`serve`は対象repository、GitHub App installation、Linear workspace、OAuth token、現在のschemaについて次を検証する。history snapshotと本文値は現在のreconciliationで使う一過性の証拠であり、別の正本へ保存しない。current Todo episodeを指すapproval episode keyだけはJob identity/lease keyのprovider pointerとして保存する。

1. current Linear state、current attachment、GitHub Issue、GitHub/Linearのtitle・本文、target base ref/OIDを取得できること。
2. current Todo承認を一意に特定し、そのimmutable `IssueHistory.id`をapproval episode keyとして取得・再構成できること。keyが指す承認からread時点までのstate、attachment、title、本文に関するnative historyを全page・全必要fieldで取得できなければならない。group化、同時刻、partial error、missing page、またはfieldの意味が曖昧なら不合格とする。
3. GitHubとLinearの履歴を、承認対象の同一性と承認後の非変更を証明できる順序へ結び付けられること。provider timestampの比較だけ、webhook delivery順、またはcurrent valueの一致だけでは合格にしない。
4. GitHub App installation/tokenで、`updateRefs`のtarget base refに対する`beforeOid = afterOid = expectedBaseOid`のno-op compareが受け付けられること。実際のsealではこのcompareとcanonical refのzero-OID createを一つのatomic `updateRefs`に含める。未対応、権限不足、または結果不明なら別のcreate APIへfallbackしない。
5. branch create前後の再読でも同じ証明が維持されること。attachment relink、本文更新、base advance、token可視性低下、rate limit、API error、またはschema driftのどれかで証明不能になれば、そのattemptをfail closedすること。

実装前に一回行うcapability testは、query shape、required permission、error処理、pagination実装を確認する価値がある。しかしそれだけでは上の完全性を普遍的に証明しない。providerがその契約を公開するか、または当該repositoryの実行時観測で各admissionの証明を満たすまで、automatic admissionを実装・有効化しない。

## 設計への帰結

- webhook delivery ID、payload、timestamp、approval episode key以外のhistory IDは通知または一過性の証拠であり、Job identity、lease key、canonical branch、external operation requestのversion tokenにしない。current Todo episodeの`IssueHistory.id`だけはapproval episode keyとしてJob identity/lease keyへ入るが、fingerprint、branch名、本文/revision fieldにはならない。
- approval fingerprintの正確なencoding、branch封印順序、既存branch/resume、external operation fencingは[ADR 0003](../adr/0003-approval-admission-and-reconciliation.md)を正本とする。
- 履歴が不十分な場合にreceipt、comment、label、attachment、relay state、SQLite state、Git ref、または本文copyを追加して穴埋めしない。人間による新しいTriage→Todo承認以外にautomatic admissionを復旧させない。
