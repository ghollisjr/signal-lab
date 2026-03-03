import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => ({
  plugins: [react()],
  // For local dev, use '/'. For GitHub Pages, use '/REPO_NAME/'
  // Replace 'signal-lab' with your actual GitHub repository name
  base: command === 'serve' ? '/' : '/signal-lab/',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
}))
