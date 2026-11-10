// Typographic logo: the word «إنجاز» set in Alexandria Black, converted to outlines
// (so it never depends on a font loading). Letters use the text colour, the three dots are lime.
export const WORDMARK = {"viewBox": "-10 -911 2254 1294", "parts": [{"d": "M0 82Q53 79 81.5 69.0Q110 59 121.0 42.0Q132 25 132 1V-537H325V1Q325 86 289.5 150.0Q254 214 189.5 251.5Q125 289 36 295Z", "dot": false}, {"d": "M229 -640Q183 -640 154.0 -668.5Q125 -697 125 -743Q125 -789 154.0 -818.0Q183 -847 229 -847Q275 -847 304.0 -818.0Q333 -789 333 -743Q333 -697 304.0 -668.5Q275 -640 229 -640Z", "dot": true}, {"d": "M445 0V-901H638V-225H743Q751 -225 757.0 -194.5Q763 -164 763 -114Q763 -62 757.0 -31.0Q751 0 743 0Z", "dot": false}, {"d": "M743 0Q735 0 729.0 -31.0Q723 -62 723 -114Q723 -164 729.0 -194.5Q735 -225 743 -225H1187V-271Q1187 -299 1168.0 -321.5Q1149 -344 1112.0 -357.0Q1075 -370 1021 -370Q984 -370 944.5 -362.0Q905 -354 876 -342L791 -531Q843 -563 902.0 -579.0Q961 -595 1021 -595Q1090 -595 1154.0 -574.5Q1218 -554 1269.0 -513.0Q1320 -472 1350.0 -411.5Q1380 -351 1380 -271V-225H1495Q1503 -225 1509.0 -194.5Q1515 -164 1515 -114Q1515 -62 1509.0 -31.0Q1503 0 1495 0Z", "dot": false}, {"d": "M1068 311Q1022 311 993.0 282.5Q964 254 964 208Q964 162 993.0 133.0Q1022 104 1068 104Q1114 104 1143.0 133.0Q1172 162 1172 208Q1172 254 1143.0 282.5Q1114 311 1068 311Z", "dot": true}, {"d": "M1654 -537H1847V0H1495Q1487 0 1481.0 -31.0Q1475 -62 1475 -114Q1475 -164 1481.0 -194.5Q1487 -225 1495 -225H1654Z", "dot": false}, {"d": "M1751 -640Q1705 -640 1676.0 -668.5Q1647 -697 1647 -743Q1647 -789 1676.0 -818.0Q1705 -847 1751 -847Q1797 -847 1826.0 -818.0Q1855 -789 1855 -743Q1855 -697 1826.0 -668.5Q1797 -640 1751 -640Z", "dot": true}, {"d": "M1977 0V-901H2170V0Z", "dot": false}, {"d": "M1914 373V267H1950Q1941 247 1941 221Q1941 179 1965.0 148.0Q1989 117 2028.5 100.5Q2068 84 2113 84Q2141 84 2167.5 90.0Q2194 96 2217 109L2178 195Q2165 193 2150.0 191.0Q2135 189 2122 189Q2081 189 2056.5 201.0Q2032 213 2032 228Q2032 242 2056.5 254.5Q2081 267 2123 267H2234V373Z", "dot": false}]};

export function wordmarkSVG(cls = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', WORDMARK.viewBox);
  svg.setAttribute('class', 'wordmark ' + cls);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'إنجاز');
  WORDMARK.parts.forEach((p, i) => {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', p.d);
    path.setAttribute('pathLength', '1');
    path.setAttribute('class', p.dot ? 'wm-dot' : 'wm-letter');
    path.style.setProperty('--k', i);
    svg.append(path);
  });
  return svg;
}
