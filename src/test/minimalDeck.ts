export const VALID_MINIMAL_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Minimal Deck</title>
  </head>
  <body>
    <main id="stage" style="width: 1920px; height: 1080px">
      <section class="slide" id="intro"><h1>Introduction</h1></section>
      <section class="slide"><p>Fallback label</p></section>
    </main>
  </body>
</html>`;

export const VALID_INLINE_DIMENSIONS_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Inline Dimensions Deck</title>
  </head>
  <body>
    <main id="stage" style="width: 1440px; height: 810px">
      <section class="slide"><h1>Inline dimensions</h1></section>
    </main>
  </body>
</html>`;

export const VALID_STYLESHEET_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Stylesheet Deck</title>
    <style>
      #stage {
        width: 1600px;
        height: 900px;
      }
    </style>
  </head>
  <body>
    <main id="stage">
      <section class="slide"><h1>Styled slide</h1></section>
    </main>
  </body>
</html>`;

export const VALID_CASCADE_SPECIFICITY_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Specificity Deck</title>
    <style>
      #stage { width: 1600px; height: 900px; }
      main { width: 1200px; height: 675px; }
    </style>
  </head>
  <body>
    <main id="stage">
      <section class="slide"><h1>Specificity</h1></section>
    </main>
  </body>
</html>`;

export const VALID_CASCADE_IMPORTANT_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Important Deck</title>
    <style>
      main { width: 1280px !important; height: 720px !important; }
      #stage { width: 1600px; height: 900px; }
    </style>
  </head>
  <body>
    <main id="stage">
      <section class="slide"><h1>Important</h1></section>
    </main>
  </body>
</html>`;

export const VALID_SOURCE_ORDER_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Source Order Deck</title>
    <style>
      #stage { width: 1600px; height: 900px; }
      #stage { width: 1280px; height: 720px; }
    </style>
  </head>
  <body>
    <main id="stage">
      <section class="slide"><h1>Source order</h1></section>
    </main>
  </body>
</html>`;

export const VALID_INLINE_PRIORITY_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Inline Priority Deck</title>
    <style>#stage { width: 1600px !important; height: 900px !important; }</style>
  </head>
  <body>
    <main id="stage" style="width: 1440px; height: 810px">
      <section class="slide"><h1>Inline priority</h1></section>
    </main>
  </body>
</html>`;

export const VALID_PRINT_STYLE_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Print Style Deck</title>
    <style>#stage { width: 1600px; height: 900px; }</style>
    <style media="print">#stage { width: 800px; height: 450px; }</style>
  </head>
  <body>
    <main id="stage">
      <section class="slide"><h1>Screen dimensions</h1></section>
    </main>
  </body>
</html>`;

export const VALID_DISABLED_STYLE_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Disabled Style Deck</title>
    <style>#stage { width: 1600px; height: 900px; }</style>
    <style disabled>#stage { width: 800px; height: 450px; }</style>
  </head>
  <body>
    <main id="stage">
      <section class="slide"><h1>Enabled dimensions</h1></section>
    </main>
  </body>
</html>`;

export const VALID_INVALID_INLINE_DIMENSIONS_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Invalid Inline Units Deck</title>
    <style>#stage { width: 1600px; height: 900px; }</style>
  </head>
  <body>
    <main id="stage" style="width: 75%; height: 80vh">
      <section class="slide"><h1>Invalid inline units</h1></section>
    </main>
  </body>
</html>`;

export const VALID_INVALID_STYLESHEET_DIMENSIONS_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Invalid Stylesheet Units Deck</title>
    <style>#stage { width: 75%; height: 80vh; }</style>
  </head>
  <body>
    <main id="stage">
      <section class="slide"><h1>Invalid stylesheet units</h1></section>
    </main>
  </body>
</html>`;

export const VALID_ZERO_DIMENSIONS_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Zero Dimensions Deck</title>
  </head>
  <body>
    <main id="stage" style="width: 0; height: 0">
      <section class="slide"><h1>Zero dimensions</h1></section>
    </main>
  </body>
</html>`;

export const VALID_FALLBACK_DECK = `<!doctype html>
<html lang="en">
  <head>
    <title>Fallback Deck</title>
  </head>
  <body>
    <main id="stage">
      <section class="slide"><h1>Fallback dimensions</h1></section>
    </main>
  </body>
</html>`;

export const INVALID_MISSING_STAGE = `<!doctype html>
<html lang="en">
  <head><title>Missing Stage</title></head>
  <body><section class="slide">Orphaned slide</section></body>
</html>`;

export const INVALID_NO_SLIDES = `<!doctype html>
<html lang="en">
  <head><title>No Slides</title></head>
  <body>
    <main id="stage">
      <div class="slide-wrapper">
        <section class="slide">Nested slide</section>
      </div>
    </main>
  </body>
</html>`;
