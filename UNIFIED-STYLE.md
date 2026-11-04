# Whole-site visual restyle

Target: current approved hero/header and WhatsApp-inspired estimate panel. Carry rounded neutral surfaces, charcoal-green dark panels, pill controls, light borders, gentle shadows and orange primary actions throughout the rest of the site.

Arrangement lock: preserve all HTML body structure, content, section sequence, grids, columns, image placements, service-tab positions, form steps, route destinations and interactions. New shared CSS changes surfaces, colors, corners, font weights and detail treatments. It does not redefine grid layouts, widths, heights, order, or section spacing. The approved homepage hero and header remain as built.

The existing Refero research and user-provided hero references define the visual source. Orange retains its primary-action role. Dark surfaces borrow the hero estimate panel's charcoal palette; neutral surfaces borrow the current header. No imagery or business copy changed.

Implementation: dist/unified-style.css, linked after the existing styles in build.mjs. Arrangement verification compares SHA-256 of every generated HTML body before and after adding the stylesheet.

User correction: preserve the original white-and-orange colors. The unified stylesheet now contains geometry/typography and neutral shadow treatments only; colors inherit from the previous stylesheets.
