# URUOI 水分管理

1日の水分摂取を記録して目標を管理するPWA。
公開先は https://kazukitakeru-dotcom.github.io/wowo/

リポジトリ名 `wowo` とアプリ名 `URUOI` は不一致だが意図的にそのまま
（改名すると Pages の URL が変わり、ホーム画面に追加済みのアプリが切れるため）。

## 構成

| ファイル | 中身 |
|---|---|
| `index.html` | 画面・スタイル・アプリ本体（全ロジックが1枚に入っている） |
| `sync.js` | 複数端末同期（Supabase）。アプリ本体は無改造で、`window.URUOI` 越しに触る |
| `sw.js` | Service Worker |
| `manifest.json` / `icons/` | PWA 設定とアイコン |
| `supabase.sql` | Supabase のテーブル定義。ダッシュボードの SQL Editor に貼って実行する |

## データ

localStorage のキー `uruoi_water_v2` に全部入りの JSON。

```
{
  profile:        { sex, height, weight, bathCount, bathMin, bathIntensity, defaultTargetMl },
  quickAdds:      [150, 200, ...],
  daily:          { 'YYYY-MM-DD': { targetMl, entries: [{ id, t, ml }] } },
  deletedEntries: { 記録ID: { d: 'YYYY-MM-DD', at: ms } },   // 消した記録の墓標
  knowledge:      { unlocked: [], awardedByDate: {}, seriesIndex: {}, activeSeries },
  settings:       { rolloverRules: [{ fromTs, hour }] }      // 集計日の区切り時間の履歴
}
```

`daily` のキーは「暦の日付」ではなく **区切り時間を適用した集計日**（`dateKeyLocal()`）。
画面上の日付表示は `dateKeyCalendar()` で、こちらは 0:00 で切り替わる。混同しないこと。

## 改修時の注意

- **ファイルを更新したら `sw.js` の `CACHE_NAME` を必ず上げる。**
  上げないと古いキャッシュが配られて変更が届かない。新しいファイルは `ASSETS` にも足す。
- ローカル確認は `python -m http.server` → localhost で開く。file:// だと Service Worker が動かない。
  localhost は本番と別オリジンなので、実データには触れない（テスト投入も安全）。
- 記録を新しく作る場所では **必ず `id` を振る**（`newEntryId()`）。IDが無い記録は同期できない。
- 記録を消す場所では **必ず `state.deletedEntries` に墓標を残す**。
  残さないと、まだその記録を持っている端末から押し戻されて復活する。

## 複数端末同期の設計

同じ Supabase プロジェクトに、わんにゃんメモリー／達人への道／IRON LOG と相乗りしている。
ログインはメール＋パスワード（マジックリンクは iOS のホーム画面アプリで詰む）。
未ログインなら同期処理は一切走らず、導入前とまったく同じ挙動になる。

**このアプリの肝は「状態を丸ごと last-write-wins にしてはいけない」こと。**
水分記録は1日かけて積み上げるものなので、全体を上書きすると片方の端末で飲んだ分が消える。
そのためデータの性質ごとに規則を分けてある。

| 中身 | テーブル | 規則 |
|---|---|---|
| 飲んだ記録 | `uruoi_entries` | 1杯=1行の**追記マージ**。内容は後から変わらないので衝突しない。消したものは `deleted` で伝え、**いちど消えたら復活させない（削除優先）** |
| 日ごとの目標 | `uruoi_days` | 1日1行の last-write-wins。ただし未送信のローカル変更があればそちらを残す |
| 設定・水知識 | `uruoi_state` | 1ユーザー1行の jsonb を**項目ごとにマージ**（下記） |

`uruoi_state` の項目ごとの規則：

- `profile` / `quickAdds` / `activeSeries` … 後に変えた方が勝つ（`doc.rev` に項目ごとの変更時刻を持つ）
- `settings.rolloverRules` … `fromTs` で**時系列に合流**させる。
  丸ごと上書きすると片方の端末で設定した区切りが消え、過去の集計日がずれて記録が別の日に移動して見える
- `knowledge.unlocked` … **和集合**
- `knowledge.seriesIndex` … **最大値**
- `knowledge.awardedByDate` … 先に入っている方を残す

水知識を last-write-wins にすると集めたスタンプが巻き戻る。ここは絶対に上書きしない。
両端末が同じ日に別々のスタンプを解禁した場合は2つとも残る（1日1個の建前は崩れるが、
消えるより良いという判断）。

### その他の作り

- `updated_at` は**サーバーの `now()`**（トリガで設定）。端末の時計で入れると、時計がずれた端末の
  行が「前回より新しい行だけ取る」差分同期の網から永久に漏れる。
- 取得位置は取りこぼし防止のため 5 秒だけ巻き戻して覚える。重複して取っても害はない。
- 1回の GET は 1000 件が上限なので、`_restAll()` でページを送って全部取る。
  記録は1年で数千件になるため、ここを忘れると古い記録が静かに欠ける。
- クラウドの内容を反映する直前に、この端末のデータを丸ごと控える（`uruoi_rollback_v1`）。
  設定画面の「取り込み前に戻す」で1タップ戻せる。
- 墓標は1年保持する（`TOMBSTONE_KEEP_MS`）。
- バックアップの読み込みは「合流」ではなく「置き換え」。同期中に読み込むと、
  今ある記録のうち読み込む側に無いものへ自動で墓標を立てる（他端末からの復活を防ぐため）。

### テーブルを足すとき

このプロジェクトは複数アプリの相乗り前提なので、毎回
**「`authenticated` に grant ／ `anon` から revoke ／ RLS＋ポリシー」を明示する**こと。
自動設定に頼らない構成にしてある。実例は `supabase.sql`。
