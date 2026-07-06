import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: '애타 - AnyTime',
        short_name: '애타',
        description: '공군사관학교 강의정보 공유 PWA',
        lang: 'ko',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icons/icon.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
        ],
        // 자기 자신(WebAPK)을 관련 앱으로 등재 → 브라우저에서 getInstalledRelatedApps 로
        // "이미 설치됨"을 감지해 설치 게이트 대신 앱으로 바로 보낼 수 있다(Android Chrome).
        // 두 배포 도메인 모두 등재. prefer_related_applications 는 두지 않는다(true 면 설치 유도가 스토어로 감).
        related_applications: [
          { platform: 'webapp', url: 'https://anytime.rokafa.app/manifest.webmanifest' },
          { platform: 'webapp', url: 'https://anytime-dzi.pages.dev/manifest.webmanifest' }
        ]
      },
      workbox: {
        // 웹푸시 수신 핸들러(public/push-sw.js)를 생성된 sw.js 에 포함.
        // ※ push-sw.js 내용만 바꾸면 SW 갱신이 안 잡힌다 — 수정 시 ?v=N 을 올릴 것.
        importScripts: ['push-sw.js?v=3'],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // 관리자 전용 무거운 청크(편람 PDF 파서 pdfjs 등)는 프리캐시에서 제외.
        // 대다수(시간표 확인용)의 설치를 가볍게 유지 — 해당 페이지는 접속 시 그때 로드된다.
        globIgnores: ['**/syllabus-*.js', '**/pdf.worker*', '**/Admin-*.js'],
        // 오프라인: 어떤 경로로 새로고침해도 앱 셸(index.html)을 캐시에서 반환
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /supabase/],
        cleanupOutdatedCaches: true
      }
    })
  ]
});
