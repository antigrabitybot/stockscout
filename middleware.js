/**
 * middleware.js — Vercel Edge Middleware による Basic 認証
 * ----------------------------------------------------------------------------
 * Vercel Hobby プランには Password Protection 機能がないため、
 * この middleware で簡易 Basic 認証をかける。
 *
 * 環境変数の設定(Vercel Dashboard → Settings → Environment Variables):
 *   SITE_USER     : ログインIDにしたい任意の文字列
 *   SITE_PASSWORD : ログインパスワードにしたい任意の文字列
 *
 * 両方とも未設定の場合は認証をスキップする(ローカル開発を妨げないため)。
 */
export const config = {
  matcher: "/:path*",
};

export default function middleware(request) {
  const user = process.env.SITE_USER;
  const password = process.env.SITE_PASSWORD;

  // 環境変数が未設定の場合は認証をスキップ(ローカル開発用)
  if (!user || !password) {
    return;
  }

  const authHeader = request.headers.get("authorization") || "";
  if (authHeader.startsWith("Basic ")) {
    const base64 = authHeader.slice(6);
    const decoded = atob(base64);
    const [inputUser, ...rest] = decoded.split(":");
    const inputPassword = rest.join(":"); // パスワードに:が含まれる場合を考慮
    if (inputUser === user && inputPassword === password) {
      return; // 認証成功 → そのまま通す
    }
  }

  // 認証失敗 → 401 を返してブラウザに認証ダイアログを表示させる
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="StockScout"',
      "Content-Type": "text/plain",
    },
  });
}
