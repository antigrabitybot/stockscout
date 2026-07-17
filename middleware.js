// middleware.js — 認証なし（全アクセス許可）
// Basic認証を削除しました。全リクエストをそのまま通します。

export const config = {
  matcher: "/:path*",
};

export default function middleware(request) {
  // 認証なし：そのまま通す
  return;
}
