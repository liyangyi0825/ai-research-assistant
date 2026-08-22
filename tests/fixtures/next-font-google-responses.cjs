const variableFontCss = (family) => `/* latin */
@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
  src: local('Arial');
}`;

module.exports = {
  "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap":
    variableFontCss("Geist"),
  "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap":
    variableFontCss("Geist Mono"),
};
