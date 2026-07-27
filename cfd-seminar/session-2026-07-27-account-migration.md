# 2026-07-27 セッションメモ：GitHubアカウント移管

## 決定

- リポジトリを旧実名オーガニゼーション `KIDENA-Fumiya` から新しい実名アカウント `fumiya-kidena` へ移管する。
- 移管後のリポジトリは `https://github.com/fumiya-kidena/cfd-seminar`。
- リポジトリのvisibilityはprivateを維持する。
- 公開教材は従来どおり `https://fumiya-kidena.github.io/public-pages/cfd-seminar/` へ配信する。
- 配信先への書き込みはActions secret `PUBLIC_PAGES_DEPLOY_KEY` を使う。リポジトリ移管後もsecretとworkflowを維持する。

## 旧組織の整理

`KIDENA-Fumiya` 配下のリポジトリを空にする方針。`public-pages` は移行済みの同名リポジトリと衝突するため、旧リポジトリを `public-pages-legacy` に改名してから `fumiya-kidena` へ移す。

## 実行状況

- `cfd-seminar` はGitHub APIの制約により `KIDENA-Fumiya` → `kidefumi` → `fumiya-kidena` の二段階で移管する。
- 旧組織から `kidefumi` への移管は完了した。
- `fumiya-kidena` への移管招待は送信済み。個人アカウント間の移管は、受け側に届く確認メールの承認が必須で、24時間で失効する。
- 受諾後に `PUBLIC_PAGES_DEPLOY_KEY`、workflow、default branch、private visibilityを再確認する。
- 旧組織そのものは、受諾と受け側検証が終わるまで削除しない。
