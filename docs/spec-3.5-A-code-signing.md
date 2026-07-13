# 3.5-A コード署名の選択肢 調査結果（2026-07-13）

ロードマップ 3.5-A の調査タスクの成果物。**購入・契約の判断はユーザーが行う**（運用ルール領域4）。
本書は選択肢と事実の整理までを行い、最後に判断材料としての示唆を付す。

前提となる配布形態: Electron 製 Windows アプリ／NSIS インストーラ／GitHub Releases 配布／
グローバル入力フック（uiohook-napi）による AV 誤検知・SmartScreen 警告リスクあり。
為替は目安として 1 USD ≈ 150 円で換算（実勢で変動）。

## 要点（先に結論）

1. **EV 証明書の「SmartScreen 即時信頼」は 2024 年に廃止された。** 現在は OV も EV も
   SmartScreen 上の扱いは同等で、通常のユーザーモードアプリに EV は過剰投資。
2. **最安・CI 最良の Azure Trusted Signing（現名称 Artifact Signing）は日本が対象外**
   （2026-07 時点。米・加・EU・英の組織／米・加の個人のみ）。地域拡大は「作業中・ETA なし」。
3. どの選択肢でも**警告は即時には消えない**。同一証明書で署名を続けて発行元レピュテーションを
   積むことが本質（目安: 数週間＋幅広いユーザーからの数百件のクリーンなインストール）。
4. 2023-06 以降、秘密鍵はハードウェア（USB トークン／HSM／クラウド HSM）必須。
   `.pfx` ファイル受け取りは廃止。さらに 2026-03-01 から証明書の最大有効期間が 460 日に短縮。
5. **証明書の CN（発行先名）を変えると electron-updater の自動更新が壊れる**
   （`publisherName` 検証）。取得時から会社名表記を固定する意識が必要。

## 1. OV コード署名証明書

- GMO グローバルサイン（日本法人）: **60,000円/年（税別）**。日本語申請・円建て・請求書払い。
  日本企業には手続きが最も容易。
  （出典: https://codenote.net/en/posts/ov-ev-code-signing-certificate-pricing-japan-2026/ ）
- Sectigo Japan（comodo.jp）: **55,000円/年（税別）＋USB トークン 15,000円（税別）**。
  「個人事業主取得可」「個人取得可」と明記。
  （出典: https://comodo.jp/products/codesign.html ）
- DigiCert: 定価 OV 696 USD/年（約10.4万円）。国内リセラー経由で 97,900円/年＋トークン
  18,700円の例。
  （出典: https://www.slogical.co.jp/ssl/details/digicert_code_signing/ ）
- SSL.com: OV / IV（個人実在確認）とも **129 USD/年（約1.9万円）** と最安級。ただし
  クラウド署名 eSigner は別料金（Tier 1 で月 20 USD・10署名/月＋超過課金。年払い25%引き。
  解約で残クレジット失効・再加入 150 USD）。
  （出典: https://www.ssl.com/products/software-integrity/signing-service/ 、
  https://www.ssl.com/guide/esigner-vs-hardware-token/ ）
- Certum: クラウド型 Code Signing 約 116 USD〜の海外リセラー価格。
  （出典: https://www.sslmentor.com/certum/certumcodecloud ）

**取得要件**: 日本法人はほぼ全 CA で可（登記情報・第三者DB照会・代表電話コールバック）。
個人事業主は Sectigo 等一部で可。純粋な個人は大手 CA では原則不可（SSL.com の IV か
Certum Open Source が受け皿）。DUNS ナンバー（日本は東京商工リサーチ管轄）があると
海外 CA の審査が大幅短縮（新規登録は無料枠で約1.5か月、有料特急で約1週間）。

**ハードウェア必須化（2023-06〜）**: CA/Browser Forum の Baseline Requirements 改定で、
OV/EV とも秘密鍵は FIPS 140-2 Level 2 / CC EAL4+ 以上のハードウェアで生成・保管が必須。
CSC-31 により 2026-03-01 から最大有効期間 39か月 → **460日（約15か月）** に短縮され、
複数年契約でも毎年再発行＋準拠デバイス再受領が前提になる。一部 CA（GlobalSign 等）は
トークンを注文地域外へ発送しないため、海外 CA 直販より国内リセラーかクラウド署名が安全。
（出典: https://www.ssldragon.com/blog/code-signing-certificate-providers/ ほか）

**CI（GitHub Actions）**: USB トークン型はホステッドランナーでは物理的に不可
（セルフホステッドランナーか手元 PC での署名になる）。CI 完全自動化にはクラウド署名を
選ぶ — SSL.com eSigner（GitHub Actions ガイドあり）、DigiCert KeyLocker、
GlobalSign の Azure Key Vault 連携 HSM 型（要見積）など。

## 2. EV コード署名証明書

- 費用: SSL.com EV 349 USD/年（複数年で 149 USD/年まで逓減）＋トークンまたは
  eSigner EV（月 100 USD〜）。GMO グローバルサイン EV 78,000円/年（税別）。
  Sectigo EV はリセラーで 296 USD〜。
- 要件: 原則法人のみ（審査は厳格で発行も遅い）。例外として SSL.com に
  「EV Sole Proprietor（個人事業主向け EV）」がある。
- **SmartScreen 即時信頼は廃止済み**: 2024 年に Microsoft が挙動を変更し、2024-08 には
  Microsoft Trusted Root Program の既存ルートから EV Code Signing OID が削除され、
  全コード署名証明書が同等扱いに。Microsoft 公式ドキュメントも「EV は SmartScreen を
  バイパスしない。SmartScreen 回避目的で EV にプレミアムを払う正当性はもはやない」と明記。
  （出典: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation ）
- 2026 年時点で EV が必須なのはカーネルモードドライバ署名等のみ。
  **通常のユーザーモード Electron アプリには OV で十分。**

## 3. Azure Trusted Signing（現名称: Artifact Signing）

- 名称変更: Trusted Signing → **Artifact Signing**（機能・価格は同一）。
  （出典: https://azure.microsoft.com/en-us/products/artifact-signing ）
- 費用: Basic **9.99 USD/月**（5,000署名/月、超過 0.005 USD/署名）、Premium 99.99 USD/月。
  無料/トライアル Azure サブスクリプションでは利用不可。
- 技術: FIPS 140-2 Level 3 HSM。証明書は毎日更新・有効期間 72 時間の短命証明書で
  ゼロタッチ管理。GitHub Actions 公式アクション（`azure/trusted-signing-action`）あり。
  electron-builder はネイティブ対応（`win.azureSignOptions`）。
- **要件（最重要）**: Public Trust 証明書は「米・加・EU・英の組織、および米・加の個人」のみ。
  **日本は法人・個人とも対象外（2026-07 時点）**。日本の組織で Identity Validation の
  国リストに Japan が出ない事例が Microsoft Q&A に複数報告。地域拡大は「作業中・ETA なし」。
  「組織3年以上の実績」要件の GA 時点での扱いは要確認。
  （出典: https://learn.microsoft.com/en-us/azure/artifact-signing/faq 、
  https://learn.microsoft.com/en-us/answers/questions/2243504/trusted-signing-for-other-countries ）
- **結論: 現時点で日本の開発元は選択肢にならない。** 日本追加時には最有力候補に昇格するため、
  対象国リストの定期確認を推奨。

## 4. Certum Open Source Code Signing（個人・OSS 向け低価格）

- 費用: 「Open Source Code Signing in the Cloud」**58 USD（約8,700円）/年〜**
  （公式ストア表示。取材時点で "out of stock" 表示あり — 販売状況は要確認。
  リセラーでは €189/年等の表示もあり価格はばらつく）。
  （出典: https://certum.store/open-source-code-signing-on-simplysign.html ）
- 要件: オープンソースとして公開するソフトが対象。個人名義で発行され、証明書の表示名に
  「Open Source Developer, （氏名）」プレフィックスが付く。身分証による個人実在確認あり。
- クラウド署名: SimplySign クラウド（クラウド HSM）で物理カード不要。ただし認証が
  スマホアプリの TOTP 前提のため、GitHub Actions での完全無人署名は困難
  （セルフホスト＋手動 OTP の半自動が現実的。完全自動化の可否は要確認）。月5,000署名上限。

## 5. SmartScreen レピュテーションの実態

- 判定は「発行元（証明書）レピュテーション」と「ファイルハッシュレピュテーション」の2軸。
  署名済みでも新規バイナリは実績が貯まるまで「認識されないアプリ」警告が出得る。
- 警告解消の目安: 明確な閾値は非公開。「数週間、幅広いユーザーからの数百件のクリーンな
  インストール」と Microsoft が明記。一般向けの手動申請の仕組みはない。
- OV/EV の差は現在**ゼロ**。同じ証明書で署名を続ければ発行元レピュテーションが引き継がれ、
  新バージョンの警告を回避しやすくなる — これが署名の最大の実益。
- 警告を完全に回避できるのは Microsoft Store（MSIX）配布のみ（Microsoft が再署名し
  ダウンロード警告の対象外）。GitHub Releases 配布と併用も可能。
  （出典: https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation ）

## 6. electron-builder / electron-updater 統合の要点

- electron-builder は NSIS ターゲットでアプリ本体 exe・インストーラ・アンインストーラを
  自動署名（SHA1+SHA256 デュアル署名）。electron-updater は Windows で更新ファイルの署名を
  検証（`verifyUpdateCodeSignature`、既定有効）し、`publisherName` が証明書の CN と
  一致しないと更新を拒否する。（出典: https://www.electron.build/code-signing-win ）
- **CN を変更すると自動更新が壊れる**: 旧バージョンが検証する publisherName と新証明書の
  CN が食い違うと `not signed by the application owner` エラー。
  `win.signtoolOptions.publisherName` に新旧両名を配列で入れた「橋渡しリリース」を挟むのが定石。
  （出典: https://github.com/electron-userland/electron-builder/issues/9175 ）
- OV/EV（USB トークン）: `win.certificateSubjectName` / `certificateSha1` でトークンを挿した
  マシンの署名ストアを参照（セルフホステッドランナー等）。`certificateFile`/`CSC_LINK`
  （.pfx）方式は 2023-06 以降新規発行がなく事実上終了。
- Azure Artifact Signing: `win.azureSignOptions` をネイティブサポート
  （認証は `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`）。
- SSL.com eSigner: ネイティブ対応はなく `win.sign` カスタムフックから CodeSignTool を呼ぶ。
  SSL.com が GitHub Actions 等の CI ガイドを公開。
- Certum SimplySign: SimplySign Desktop がローカル CSP として証明書を見せるため、接続中の
  マシンでは通常の signtool 署名が動く（CI 完全自動化は困難・要確認）。

## 比較表（2026-07 時点・日本の開発元から見た評価）

| 選択肢 | 年間費用目安 | 法人 | 個人事業主 | 個人 | 日本から取得 | SmartScreen 効果 | GitHub Actions 署名 | electron-builder 統合 |
|---|---|---|---|---|---|---|---|---|
| OV（GMO GlobalSign） | ¥60,000（税別） | ○ | △（要確認） | × | ◎（日本語・円建て） | 実績蓄積で警告解消（EVと同等） | △ トークン不可。HSM/Key Vault 型なら可（要見積） | `certificateSubjectName` ほか |
| OV（Sectigo Japan） | ¥55,000（税別）＋トークン¥15,000 | ○ | ○ | ○（表記上。要確認） | ◎（国内代理店） | 同上 | × トークンのみ（セルフホスト必要） | 同上 |
| OV/IV（SSL.com）＋eSigner | $129＋eSigner 月$20〜（計 約¥55,000〜） | ○ | ○ | ○（IV） | ○（英語手続き） | 同上 | ◎ 完全クラウド・CI ガイドあり | `win.sign` フック＋CodeSignTool |
| EV（各社） | ¥78,000〜$349＋α | ○ | △（SSL.com のみ） | × | ○ | **OVと同じ**（即時信頼は2024年廃止） | △ eSigner EV（月$100〜）なら可 | OVと同様 |
| Azure Artifact Signing | $9.99/月（約¥18,000/年） | **×（日本対象外）** | × | × | **×** | 実績蓄積型（Microsoft 推奨） | ◎ 公式アクション | ◎ ネイティブ対応 |
| Certum Open Source（クラウド） | $58〜（約¥9,000〜、販売状況要確認） | ×（OSS個人向け） | △ | ○（OSS 限定・CN に個人名） | ○ | 同上 | △ TOTP 必要で完全自動化困難 | SimplySign 経由 signtool |
| Microsoft Store（MSIX・参考） | ¥0（開発者登録のみ） | ○ | ○ | ○ | ○ | ◎ 警告なし（MS 再署名） | ◎（提出の自動化可） | appx/msix ターゲット |

## 判断材料としての示唆（決定はユーザー）

- **法人名義で取得する場合**: 「GMO GlobalSign / Sectigo Japan の OV（円建て・国内サポート）
  ＋手元 PC またはセルフホステッドランナーで署名」か、「SSL.com OV＋eSigner
  （GitHub Actions 完全自動化）」が現実解。
- **個人名義の場合**: SSL.com IV＋eSigner。本アプリは OSS（LICENSE あり）のため
  Certum Open Source（最安・ただし発行元表示が個人名＋CI 自動化に難）も候補。
- **EV は SmartScreen 目的では過剰投資**（効果が OV と同じになったため）。
- どれを選んでも警告は即時に消えず、同一証明書での継続署名でレピュテーションを積むのが本質。
  補完策として Microsoft Store 併売（警告なし）も検討価値あり。
- 3.5-B（自動更新）との関係: electron-updater は署名検証を行うため、**証明書の CN を
  先に固定してから 3.5-B に着手する順序（ロードマップどおり 3.5-A → 3.5-B）が正しい**。
- 価格・取扱条件は変動が激しいため、**発注前に各社公式ページでの最終確認が必須**。
