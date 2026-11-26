/**
 * Single source of truth for the Apple-inspired "Liquid Glass" design system.
 * Edit values here to update the theme across the app, or set
 * ENABLE_DESIGN_SYSTEM = false to switch the design system off at once.
 */

export const ENABLE_DESIGN_SYSTEM = true;

export const DESIGN_SYSTEM = {
  colors: {
    // Canvas & Neutrals
    pageBg: '#eef2fb',
    inkPrimary: '#1d1d1f',
    inkSecondary: '#525257',
    inkMuted: '#86868b',
    inkInverse: '#ffffff',
    dropdownBg: '#ffffff',
    dropdownHoverBg: '#eef2fb',
    dropdownFooterBg: '#f5f7fc',
    stickyTableHeaderBg: '#f1f4fb',

    // Brand & Primary Interactive Accent
    accentBlue: '#00227A',
    accentBlueHover: '#0a35a3',
    rowHighlight: 'rgba(0, 34, 122, 0.06)',
    cursorFill: 'rgba(0, 34, 122, 0.05)',
    focusRingGlow: 'rgba(0, 34, 122, 0.14)',
    secondaryHoverBorder: 'rgba(0, 34, 122, 0.2)',
    pillHoverBorder: 'rgba(0, 34, 122, 0.22)',
    outlineToggleBorder: 'rgba(0, 34, 122, 0.45)',

    // Semantic / Status Colors
    danger: '#ff3b30',
    dangerHover: '#e0352b',
    dangerTextHover: '#d62c22',
    dangerBannerBg: 'rgba(255, 59, 48, 0.1)',
    dangerInlineBg: 'rgba(255, 59, 48, 0.09)',
    dangerBorder: 'rgba(255, 59, 48, 0.25)',
    success: '#34c759',
    successHighContrast: '#248a3d',
    successInlineBg: 'rgba(52, 199, 89, 0.1)',
    successBorder: 'rgba(52, 199, 89, 0.25)',
    warning: '#ff9500',

    // Glass & Translucent Surfaces
    glassSurfaceAlpha: 0.55,
    glassSurfaceFallback: 'rgba(255, 255, 255, 0.88)',
    glassPillBg: 'rgba(255, 255, 255, 0.45)',
    glassPillHoverBg: 'rgba(255, 255, 255, 0.75)',
    glassBtnSecondaryBg: 'rgba(255, 255, 255, 0.55)',
    glassBtnSecondaryHoverBg: 'rgba(255, 255, 255, 0.82)',
    glassTranslateBg: 'rgba(255, 255, 255, 0.5)',
    glassTranslateHoverBg: 'rgba(255, 255, 255, 0.82)',
    glassInputBg: 'rgba(255, 255, 255, 0.65)',
    glassInputFocusBg: 'rgba(255, 255, 255, 0.94)',
    glassInsetBg: 'rgba(255, 255, 255, 0.48)',
    glassTableWrapBg: 'rgba(255, 255, 255, 0.56)',
    modalBackdrop: 'rgba(0, 0, 0, 0.3)',
    switchTrackOff: 'rgba(0, 0, 0, 0.15)',

    // Borders & Hairlines
    pillRestingBorder: 'rgba(255, 255, 255, 0.6)',
    insetDivider: 'rgba(0, 0, 0, 0.06)',
    tableWrapBorder: 'rgba(0, 0, 0, 0.07)',
    inputBorder: 'rgba(0, 0, 0, 0.08)',
    tableFooterBorder: 'rgba(0, 0, 0, 0.09)',
    dropdownBorder: 'rgba(0, 0, 0, 0.1)',
    axisBorder: 'rgba(0, 0, 0, 0.12)',
  },
  fonts: {
    sans: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  },
  blur: {
    desktop: '24px',
    mobile: '12px',
    blobNavy: '80px',
    blobCobalt: '90px',
    blobSky: '90px',
  },
  radii: {
    pill: '9999px',
    panel: '24px',
    inset: '16px',
    banner: '14px',
    input: '12px',
  },
  shadows: {
    glassSurface:
      '0 8px 32px rgba(0, 0, 0, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
    pillActive: '0 4px 12px rgba(0, 34, 122, 0.26)',
    btnPrimary: '0 4px 14px rgba(0, 34, 122, 0.26)',
    btnPrimaryHover: '0 6px 18px rgba(10, 53, 163, 0.3)',
    translateActive: '0 3px 10px rgba(0, 34, 122, 0.24)',
    inputFocus: '0 0 0 3px rgba(0, 34, 122, 0.14)',
    dangerBtn: '0 4px 12px rgba(255, 59, 48, 0.28)',
    dropdown: '0 12px 32px rgba(0, 0, 0, 0.14)',
  },
  animation: {
    fast: '150ms ease',
  },
  chartSeriesPalette: [
    '#005192',
    '#E0457A',
    '#542C97',
    '#008BC5',
    '#A8269A',
    '#000394',
  ] as const,
} as const;

export function applyDesignSystem(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.designSystem = ENABLE_DESIGN_SYSTEM ? 'liquid-glass' : 'off';

  if (ENABLE_DESIGN_SYSTEM) {
    root.style.setProperty('--font-sans', DESIGN_SYSTEM.fonts.sans);
    root.style.setProperty('--font-mono', DESIGN_SYSTEM.fonts.mono);
    root.style.setProperty('--accent-blue', DESIGN_SYSTEM.colors.accentBlue);
    root.style.setProperty(
      '--accent-blue-hover',
      DESIGN_SYSTEM.colors.accentBlueHover
    );
    root.style.setProperty(
      '--glass-alpha',
      String(DESIGN_SYSTEM.colors.glassSurfaceAlpha)
    );
  }
}
