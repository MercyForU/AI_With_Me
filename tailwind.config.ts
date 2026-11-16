import type { Config } from 'tailwindcss';

const channel = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: channel('ink'),
        surface: channel('surface'),
        card: channel('card'),
        raise: channel('raise'),
        fg: channel('fg'),
        'fg-dim': channel('fg-dim'),
        'fg-dimmer': channel('fg-dimmer'),
        brand: channel('brand'),
        'brand-soft': channel('brand-soft'),
        'brand-blue': channel('brand-blue'),
        tint: channel('tint'),
        ok: channel('ok'),
        warn: channel('warn'),
        danger: channel('danger'),
        line: 'var(--line)',
        'line-strong': 'var(--line-strong)',
        overlay: 'var(--overlay)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        glow: 'var(--glow)',
        panel: 'var(--panel)',
      },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        popIn: {
          from: { opacity: '0', transform: 'scale(0.9)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        floaty: {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
      },
      animation: {
        'fade-up': 'fadeUp 0.28s cubic-bezier(0.22,1,0.36,1) both',
        'pop-in': 'popIn 0.22s cubic-bezier(0.22,1,0.36,1) both',
        floaty: 'floaty 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
