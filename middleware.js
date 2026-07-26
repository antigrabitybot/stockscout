/**
 * middleware.js — Vercel Edge Middleware による簡易 Basic認証
 * ----------------------------------------------------------------------------
 * ■ なぜこれが必要か
 *   Vercel の無料(Hobby)プランには、本番URLを保護する「Password Protection」
 *   機能が無い(Pro プラン + Advanced Deployment Protection アドオンで
 *   月額$150、または Enterprise 限定)。Hobby の「Vercel Authentication」は
 *   プレビューURLのみを保護し、本番ドメインは保護対象外(誰でもアクセス可能)。
 *
 *   このアプリは個人利用前提(§1.3 の法務上の注意を参照)であり、公開URLに
 *   誰でもアクセスできる状態は避けたい。そこで、無料の Vercel Edge
 *   Middleware を使い、自前で簡易的な Basic認証(ID/パスワード)をかける。
 *
 * ■ 設定方法
 *   1. Vercel のプロジェクト設定 → Environment Variables で以下を追加:
 *        SITE_USER     … ログインID(任意の文字列)
 *        SITE_PASSWORD … パスワード(任意の文字列)
 *   2. このファイルをリポジトリのルート(package.json と同じ階層)に置く
 *   3. 再デプロイすると、サイトにアクセスした際にブラウザの認証ダイアログ
 *      (ID/パスワード入力欄)が表示されるようになる
 *
 * ■ 注意
 *   Basic認証は通信経路が HTTPS であれば実用上問題ないが、URLを直接
 *   知っている第三者への「本格的な」アクセス制御ではない(強固な認証が
 *   必要な場合は Pro プランのアドオンを検討する)。個人の投資判断ツールを
 *   検索エンジンや無関係な第三者からのアクセスから守る、という当初の
 *   目的には十分な水準。
 *
 * ■ 未検証の注意
 *   開発サンドボックスから vercel.com へ接続できないため、実際の
 *   Vercel環境での動作確認はできていない。Vercel Edge Middleware の
 *   標準的な実装パターンに沿って書いているが、初回デプロイ後は
 *   必ずブラウザで認証ダイアログが出ることを確認すること。
 */

export const config = {
  matcher: "/:path*",
};

/* 文字列比較にかかる時間から正解を推測される(タイミング攻撃)のを避けるため、
   長さが違っても常に同じ回数だけ比較する。個人利用のツールで現実的な
   脅威とまでは言えないが、実装コストがほぼ無いので入れておく。 */
function safeEqual(a, b) {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length ^ sb.length;
  for (let i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export default function middleware(request) {
  const expectedUser = process.env.SITE_USER;
  const expectedPass = process.env.SITE_PASSWORD;

  /* ■ 重要な安全弁
     環境変数が未設定(undefined)のまま素朴に比較すると、認証情報を空で
     送ってきたリクエストが undefined === undefined で通過してしまい、
     サイトが誰でも閲覧できる状態になる。設定漏れのときは「通す」のでは
     なく「全て拒否する」側に倒す。 */
  if (!expectedUser || !expectedPass) {
    return new Response(
      "サーバー側の設定が未完了です。Vercel の Environment Variables に " +
      "SITE_USER と SITE_PASSWORD を設定してください。",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const auth = request.headers.get("authorization");

  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      try {
        const decoded = atob(encoded);
        const idx = decoded.indexOf(":");
        if (idx !== -1) {
          const user = decoded.slice(0, idx);
          const pass = decoded.slice(idx + 1);
          /* & ではなく両方を必ず評価することで、どちらが違ったのかを
             応答時間から区別されにくくする */
          const okUser = safeEqual(user, expectedUser);
          const okPass = safeEqual(pass, expectedPass);
          if (okUser && okPass) {
            return; // 認証OK。リクエストをそのまま通す。
          }
        }
      } catch (e) {
        /* atob() は不正な Base64 で例外を投げる。認証失敗として扱う
           (例外が外に漏れると 500 になり、認証を経ずにエラー内容が
           露出する可能性があるため、必ずここで握り潰す) */
      }
    }
  }

  return new Response("認証が必要です", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="StockScout"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
