
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    // Explicitly inject the API key during the build process
    'process.env.API_KEY': JSON.stringify(process.env.API_KEY)
  },
  server: {
    port: 3000
  },
  preview: {
    allowedHosts: true,
    // Railway provides the PORT environment variable
    port: Number(process.env.PORT) || 4173,
    host: '0.0.0.0'
  }
});
