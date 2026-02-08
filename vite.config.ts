
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': process.env
  },
  server: {
    port: 3000
  },
  preview: {
    allowedHosts: true,
    port: Number(process.env.PORT) || 4173,
    host: '0.0.0.0'
  }
});
