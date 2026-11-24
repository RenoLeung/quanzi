import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 部署到 GitHub Pages 子路径时使用相对 base，确保资源路径正确
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'es2019',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
})