# WebGL Viscous Fluid &mdash; 化粧品サイト向け原液・美容液エフェクト

![WebGL2](https://img.shields.io/badge/WebGL-2.0-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Dependencies](https://img.shields.io/badge/Dependencies-Zero-brightgreen?style=flat-square)
![Vanilla JS](https://img.shields.io/badge/Vanilla-JS-yellow?style=flat-square)

## 概要

化粧品サイト向けの「原液・美容液」質感に特化したWebGL2流体エフェクトライブラリです。依存ゼロ・`<script>` タグ1行で埋め込み可能。オリジナル実装。

セミラグランジュ移流 + ヤコビ圧力射影という古典的な格子流体シミュレーション手法をベースに、粘性拡散パス・原液グロス表現・透明ジェルモード・vorticity confinement など、化粧品LP向けの演出に寄せたオリジナルの表現レイヤーを重ねています。

## デモ

| ページ | 内容 | GitHub Pages URL |
| --- | --- | --- |
| スタジオ(調整UI付き) | 全パラメータをリアルタイム調整できる統合デモ | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?ui=1 |
| スタジオ &mdash; 原液(黒) | プリセット直リンク | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?preset=serumDark |
| スタジオ &mdash; 原液(白) | プリセット直リンク | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?preset=serumWhite |
| スタジオ &mdash; クリア | プリセット直リンク | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?preset=clear |
| スタジオ &mdash; スプラッシュ | プリセット直リンク | https://yumebi.github.io/ymb_fluid-studio/fluid-studio.html?preset=splash |
| 埋め込みサンプル(LP実装例) | 実際のLPヒーローセクションを想定した埋め込みパターン | https://yumebi.github.io/ymb_fluid-studio/embed-sample.html |
| 原液デモ(ダーク背景) | 黒背景での原液系グロス表現 | https://yumebi.github.io/ymb_fluid-studio/fluid.html |
| 原液デモ(ホワイト背景) | 白背景プロファイル + 原液/クリアジェル切替 | https://yumebi.github.io/ymb_fluid-studio/fluid-white.html |
| スプラッシュデモ | 低粘性 + vorticity confinement + レインボー | https://yumebi.github.io/ymb_fluid-studio/fluid-splash.html |
| メタボール版(軽量・旧実装) | 格子流体ではなくメタボールフィールドによる旧実装 | https://yumebi.github.io/ymb_fluid-studio/metaball.html |
| トップページ | デモ一覧ランディングページ | https://yumebi.github.io/ymb_fluid-studio/ |

## 主な機能

- 🌊 格子流体シミュレーション(セミラグランジュ移流 + 圧力射影)
- 🧴 粘性制御(Jacobi拡散)
- ✨ 原液グロス表現(擬似法線 + スペキュラ + リムライト)
- 💧 透明ジェルモード
- 🌀 vorticity confinement(低粘性カラフル表現)
- 🖱️ カーソル追従 / アンビエントの2モード
- 🌓 ダーク / ライト背景プロファイル
- 🎨 レインボーカラーモード

## 使い方

### 最小埋め込みスニペット

```html
<canvas data-fluid-sim
        data-mode="cursor"
        data-background="light"
        data-color-a="#8a2438"
        data-color-b="#f2c6c2"
        style="position:absolute; inset:0; width:100%; height:100%; display:block;"></canvas>
<script src="fluid-sim.js"></script>
```

canvas要素に `data-fluid-sim` を付けるだけで、DOMContentLoaded時(またはスクリプト実行時点でDOMが既に準備済みなら即座に)自動初期化されます。生成されたインスタンスは `canvas._fluidSimInstance` に保存されます。

canvas上に重ねるオーバーレイ要素には `pointer-events:none` を指定してください(ボタン等クリックさせたい要素だけ `pointer-events:auto` で個別に復帰させます)。ポインター追従は canvas 自身に対する `pointermove` / `pointerdown` を監視しているため、これを怠るとオーバーレイがカーソルイベントを遮ってしまいます。

### data-属性リファレンス(auto-init)

| 属性 | 型 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `data-mode` | `"cursor"` \| `"ambient"` | `cursor` | カーソル追従 / 自動アンビエント |
| `data-background` | `"dark"` \| `"light"` | `dark` | 表示シェーディングのプロファイル |
| `data-color-mode` | `"palette"` \| `"rainbow"` | `palette` | 色モード(パレット固定 / 虹色) |
| `data-color-a` | hex color | `#4a0f16` | 基準色A |
| `data-color-b` | hex color | `#f0b8ae` | 基準色B |
| `data-viscosity` | 0..1 | `0.5` | 粘度 |
| `data-speed` | 0.05..5 | `1` | シミュレーション速度 |
| `data-splat-radius` | 0.01..1 | `0.25` | 注入(splat)半径 |
| `data-curl` / `data-curl-strength` | 0..50 | `0` | vorticity confinement強度(0でオフ) |
| `data-dye-dissipation` | 0..1 | `0.995` | 色の残留(散逸)率 |
| `data-velocity-dissipation` | 0..1 | `0.98` | 速度の残留(散逸)率 |
| `data-pressure-iterations` | 10..80 | `40` | 圧力ヤコビ反復回数 |
| `data-viscosity-iterations` | 0..50 | `20` | 粘性ヤコビ反復回数 |
| `data-specular` | 0..2 | `0.9` | ツヤ(スペキュラ)強さ |
| `data-shininess` | 8..200 | `60` | ツヤの鋭さ |
| `data-fresnel` | 0..1 | `0.35` | 縁の光(リムライト) |
| `data-transparency` | 0..1 | `0` | 本体の透明度(クリアジェル表現) |

### JS APIリファレンス

**コンストラクタ**

```js
var fx = new FluidSim(canvasOrSelector, {
  mode, colorA, colorB, viscosity, dyeDissipation, velocityDissipation,
  pressureIterations, viscosityIterations, splatRadius, speed,
  background, curlStrength, colorMode,
  displayParams: { specular, shininess, fresnel, transparency }
});
```

**メソッド**

| メソッド | 説明 |
| --- | --- |
| `setMode(mode)` | `'cursor'` \| `'ambient'` を切り替え |
| `setColors(colorA, colorB)` | 基準色A/Bをhexで設定 |
| `setViscosity(v)` | 粘度(0..1) |
| `setBackground(bg)` | `'dark'` \| `'light'` |
| `setDyeDissipation(v)` | 色の残留率(0..1) |
| `setVelocityDissipation(v)` | 速度の残留率(0..1) |
| `setPressureIterations(n)` | 圧力ヤコビ反復回数(10..80) |
| `setViscosityIterations(n)` | 粘性ヤコビ反復回数(0..50) |
| `setSplatRadius(v)` | 注入半径(0.01..1) |
| `setSpeed(v)` | シミュレーション速度(0.05..5) |
| `setCurlStrength(v)` | vorticity confinement強度(0..50) |
| `setColorMode(m)` | `'palette'` \| `'rainbow'` |
| `setDisplayParams({specular, shininess, fresnel, transparency})` | 表示パラメータの部分更新 |
| `setParams(obj)` | 上記すべてのキーをまとめて一括更新(未知/未指定キーは無視、値は自動クランプ) |
| `splat(xNorm, yNorm, dxNorm, dyNorm)` | 任意位置に流体を注入(座標は0..1正規化) |
| `pause()` / `resume()` | 描画ループの一時停止 / 再開 |
| `destroy()` | イベントリスナー・GLリソースを解放して破棄 |

### デモページのクエリパラメータ

| パラメータ | 対象ページ | 説明 |
| --- | --- | --- |
| `?ui=1` (または `?ui=true`) | fluid.html / fluid-white.html / fluid-splash.html / fluid-studio.html | 既定で非表示の設定パネル・キャプションを表示 |
| `?preset=serumDark\|serumWhite\|clear\|splash` | fluid-studio.html | プリセットを直接適用(`clearGel`も`clear`同様に受理) |
| `?overlay=0` | fluid-studio.html | LPオーバーレイ(見出し・CTA)を非表示 |
| 個別パラメータ上書き(例: `?viscosity=0.7&speed=1.2&curl=10&colorA=8a2438`) | fluid-studio.html | 「コピー」ボタンで出力されるJSONと同じキー名で個別上書き。`colorA`/`colorB`は`#`省略可。`curlStrength`は`curl`でも指定可 |

## プロジェクト構成

```
.
├── index.html          # トップページ(デモ一覧のランディングページ、アンビエント背景付き)
├── fluid-sim.js         # メインライブラリ: 格子流体シミュレーション(原液/美容液エフェクト)
├── fluid-studio.html    # 統合デモ: 全パラメータ調整UI + プリセット + LPオーバーレイ
├── fluid.html           # 単体デモ: ダーク背景の原液グロス表現
├── fluid-white.html     # 単体デモ: ホワイト背景 + 原液/クリアジェルプリセット
├── fluid-splash.html    # 単体デモ: 低粘性 + vorticity confinement + レインボー
├── embed-sample.html    # LP実装例(ヒーローセクションへの埋め込みパターン)
├── viscous-fluid.js     # ボーナス: 軽量メタボールベースの旧実装
├── metaball.html        # ボーナス: viscous-fluid.js を使った単体デモ
├── LICENSE              # MITライセンス
└── README.md
```

## 技術メモ

- **パイプライン構成**: advect(移流) → viscosity(粘性拡散) → splat(注入) → divergence(発散) → pressure(圧力ヤコビ解) → project(圧力勾配減算) → dye advect(色移流) → display(表示シェーディング)
- half-float(`HALF_FLOAT`)のFBOでシミュレーション場を保持
- `OES_texture_float_linear` 非対応環境向けに手動バイリニアフィルタ(`bilerp`)へフォールバック
- `visibilitychange` で非表示タブ中は自動的に描画ループを一時停止
- devicePixelRatio(dpr)は上限2にクランプしてパフォーマンスを確保

## ライセンス

MIT License © 2026 ymb
