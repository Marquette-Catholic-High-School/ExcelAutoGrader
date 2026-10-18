import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Spreadsheet green, close to Excel's #217346.
const brand: MantineColorsTuple = [
  '#e9f8ef',
  '#d5eedf',
  '#aadbbf',
  '#7cc79c',
  '#56b67f',
  '#3eab6c',
  '#30a562',
  '#219051',
  '#168047',
  '#006e3a',
];

export const theme = createTheme({
  primaryColor: 'brand',
  // Shade 8 is the lightest that keeps white text at 4.5:1 or more on filled brand (4.98:1) and red (4.51:1) in
  // both schemes. autoContrast switches filled light colors (yellow, lime) to black text.
  primaryShade: { light: 8, dark: 8 },
  autoContrast: true,
  colors: { brand },
  defaultRadius: 'md',
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  headings: { fontWeight: '650' },
  components: {
    Card: { defaultProps: { withBorder: true, radius: 'md', padding: 'lg' } },
    Paper: { defaultProps: { radius: 'md' } },
    Badge: { defaultProps: { radius: 'sm' } },
    Tooltip: { defaultProps: { withArrow: true } },
  },
});
