# public-pages
GitHub Pages用のdeployment repositoryです。公開ページと、client-side encryptionされたunlisted pageを同じ`gh-pages` branchから配信します。

## Repository layout
- `cfd-gallery/`, `cfd-seminar/`：通常の公開ページ
- `_p/`：一覧へ載せないpage。暗号化pageもrepository上のciphertext自体は公開です
- `flow-ar/`：既存FLOW AR URL用のredirect-only compatibility layer
- `_katex/`：共有KaTeX runtime
- `index.html`：通常公開ページだけを列挙するroot index

## Source of truth
このrepositoryは成果物置き場です。暗号化HTML、opaque `.enc` asset、FLOW AR runtime、redirect pageを直接編集しません。各source repositoryのbuild/deploy scriptで再生成し、生成後の差分だけをここへ反映します。

rootの`README.md`、`AGENTS.md`、`.gitattributes`は運用文書としてこのrepositoryで管理します。

## Security boundary
- GitHub repositoryとGitHub Pagesの配信fileはすべてpublicです
- `_p/`は検索一覧から外し、対象HTMLには`noindex`を付けます
- client-side encryptionはcredentialを持つ閲覧者による保存・再配布を防ぎません
- plaintext model、image、JSON、研究data、password、local absolute pathをcommitしません
- encrypted packageを確認するときも、通常は復号せずheader・scope・wrapper認証だけを監査します

## FLOW AR compatibility
印刷済みQRを維持するため、次を安定interfaceとして扱います。

- `_p/flow-ar/`以下のbase pathとentrypoint名を変更しない
- case／mode identifierをrenameしない
- `flow-ar/`のlegacy redirectを削除せず、queryとhashをそのまま転送する
- password、fixed salt、share-fragment方式を変更するときはQR再印刷を前提にする
- poster画像はimage targetでもあるため、見た目やcropを変更するときも再印刷する

## Deployment gate
push前に、少なくとも以下を確認します。

1. 変更scopeが意図したpage配下だけである
2. `_p/flow-ar/assetPack/`がopaque `.enc`のみで、各fileが`FAR1` headerを持つ
3. encrypted HTMLがStatiCrypt wrapperかつ`noindex`である
4. legacy redirectがquery/hashを保持する
5. plaintext data拡張子、secret、local path、conflict markerがない
6. JavaScript syntax、LF、`git diff --check`が正常である

FLOW AR関連pathのpush／pull requestでは、同じciphertext-only検査を
`.github/script/auditFlowArDeploy.mjs`でも実行します。

履歴は暗号packageのrotationで大きくなります。history rewriteや`gh-pages`のforce-pushは、全pageへの影響を別途確認した作業として扱います。
