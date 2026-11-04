# Xpress Garage — White & Orange Design Update

Updated from Xpress-Garage-Burgundy.zip to the design established in this chat. The original ZIP is unchanged. See RESTYLE-DECISIONS.md for design and content comparison decisions, and RESTYLE-QA.md for validation.

Run `npm run build`, `npm test`, then `npm run dev` (Node static preview at localhost:4173).

Active source: roofpro.mjs supplies the new homepage and header; legacy-showroom.mjs retains regional/footer templates; showroom.mjs exports the selected components; build.mjs renders all routes; data.mjs and repair-content.mjs hold content. dist/roofpro.css is the active shared stylesheet. dist/app.js retains the original gallery, region, service-area, and estimate interactions; dist/roofpro.js adds the new tabs and hero controls.

Eight new pages: spring-repair, cable-repair, garage-door-maintenance, bottom-seal-replacement, weatherstripping, hinges-rollers, safety-sensors, and garage-door-guide. Original routes and company contact details are preserved. Old color-study URLs now display the selected design.

The estimate flow opens a prefilled email; it does not send it or confirm a booking. Regional state selection is stored locally. No competitor prices, reviews, certifications, dealer status or warranties were imported.

The following notes describe the earlier ZIP build and remain as project history:

DOOR-inspired rebuild using the user's confirmed 63-screenshot ZIP and the company's existing content and photography. The prior local build remains in ../redesign; this directory restores the latest hosted source and contains the new implementation.

Run `npm run build`, `npm test`, then `npm run dev` for localhost:4173.

The source templates are build.mjs and showroom.mjs; data.mjs holds services, locations, FAQs and gallery entries. Browser interactions live in dist/app.js. dist/door.css defines the new shared design; build preserves CSS, JS and image assets.

38 HTML documents preserve every original route and add state-specific Pennsylvania, New Jersey and Louisiana entry points. Header state selection is remembered locally. Location pages select the corresponding state; query state is carried into estimate links. PA and NJ use 215-397-1926; LA uses 504-688-1477. Footer/state contact directories retain all correct fixed regional phones.

The estimate flow prepares an email in the visitor's email app. It does not submit server-side or confirm an appointment. State and regional contact appear in the review and email. All states use the one existing published company inbox.

See REBUILD-COMPARISON.md for section/page comparison and all 63 reference decisions; DESIGN.md for visual direction; QA.md for checks and limits. Source photography remains in dist/assets, with additional-media.json and page-image-audit.json recording provenance. The ZIP is extracted in reference-images and is used as a visual reference, not embedded as website screenshots.

The existing owner-private Sites project is preserved in .openai/hosting.json. The company's custom domain is unchanged.
