import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// StockScout は単一ファイルの React コンポーネント(StockScout.jsx)。
// Vercel にデプロイするための、最小限の Vite ビルド設定。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
});
