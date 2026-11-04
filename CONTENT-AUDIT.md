# Original-site content audit

Audit date: 2026-10-31. Source: live HTML and Yoast page/post sitemaps at https://xpressgaragedoorsrepair.com/wp-sitemap.xml. All 30 sitemap URLs fetched successfully. Browser search cache is older than current live HTML; use this audit/live HTML for current coverage.

## Verified business details

- Public brand: Xpress Garage Door Service & Repair (also Xpress Garage Door Services). The linked company is a garage-door business; “Express Housing” in the brief does not match the source brand.
- Pennsylvania telephone: 215-397-1926. Louisiana telephone on legacy pages: 504-688-1477.
- Published email: Info@xpressgaragedoorservics.com. Preserve source spelling; do not silently invent a corrected address.
- Pennsylvania office: 1807 Easton Rd, Willow Grove, PA 19090. Louisiana office: 312 Clearview Pkwy, Metairie, LA 70001. Both verified on live service-area page.
- Availability: same-day appointments, including evenings/weekends; 24-hour emergency repair. Free estimates with pricing explained before work starts.
- Services: residential repair/installation/replacement, commercial overhead doors, storefront roll-up/security gates, openers/accessories, springs, cables, rollers, panels and weather stripping.
- Named brands: Craftsman, LiftMaster, Amarr, Wayne Dalton, Clopay and Hormann.
- Older cached About page says family-owned and founded in 2019. Current live About no longer includes this history, so avoid treating those historical claims as currently reconfirmed.

## Complete page inventory

| URL path | Current page title |
|---|---|
| `/` | Garage Door Repair Willow Grove PA — Same-Day — Xpress |
| `/gallery-page-2/` | Gallery Page 2 - Xpress Garage Doors Repair |
| `/commercial-jobs-gallery/` | commercial jobs gallery - Xpress Garage Doors Repair |
| `/roll-up-garage/` | Commercial Roll up Doors New Jersey, Delaware & Philadelphia |
| `/abington-garage-door-repair-service/` | Xpress Garage Door Installation & Repairs in Abington |
| `/gallery/` | Gallery - Xpress Garage Doors Repair |
| `/service-area-all-content/` | SERVICE AREA - Xpress Garage Doors Repair |
| `/xpress-security-rolling-gate-camden-nj/` | Xpress Security Rolling Gate Camden NJ |
| `/commercial-garages-lametairie-la/` | Xpress Commercial Roll Up Doors -Steel Garage Doors LA Overhead |
| `/roll-up-gates/` | Commercial Rolling Gates Installation Philadelphia |
| `/emergency-service/` | Garage Door Emergency Repair Service |
| `/garage-door-repair/` | Door Spring Repair Willow Grove, Middleton & Philadelphia DE, NJ, PA |
| `/service-area-all-content/garage-door-repair-willow-grove-pa-willow-grove-garage-doors/` | Garage Door Repair Willow Grove PA - Xpress Garage Door |
| `/about/` | Garage Door Company in Willow Grove Pa - Xpress Garage Doors Repair |
| `/contact-us/` | Residential & Commercial Xpress Garage Door Services |
| `/service-areas/` | Service Areas - Xpress Garage Doors Repair |
| `/bensalem-garage-door-repair/` | Garage Door Repair Bensalem PA — Same-Day — Xpress |
| `/northeast-philadelphia-garage-door-repair/` | Garage Door & Gate Repair Northeast Philadelphia — Xpress |
| `/levittown-garage-door-repair/` | Levittown - Xpress Garage Doors Repair Garage Door Repair Levittown PA — Same-Day — Xpress |
| `/huntingdon-valley-pa/` | Garage Door Repair Huntingdon Valley, PA — Same-Day Service |
| `/newtown-garage-door-repair/` | Garage Door Repair Newtown PA — Openers & Doors — Xpress |
| `/doylestown-garage-door-repair/` | Garage Door Repair Doylestown PA — Same-Day — Xpress |
| `/warminster-garage-door-repair/` | Garage Door Repair Warminster PA — Same-Day — Xpress |
| `/glenside-garage-door-repair/` | Garage Door Repair Glenside PA — Same-Day — Xpress |
| `/jenkintown-garage-door-repair/` | Garage Door & Rolling Gate Repair Jenkintown PA — Xpress |
| `/elkins-park-garage-door-repair/` | Garage Door Repair Elkins Park PA — Same-Day — Xpress |
| `/our-services/` | Xpress Garage Door Services — Garage Door & Gate Repair |
| `/central-city-philadelphia-commercial-roll-gate/` | Rolling Gate Installation & Repair Philadelphia PA — Xpress |
| `/locations/philadelphila/` | Philadelphia Garage Door Services - Xpress Garage Doors Repair |
| `/locations/horsham-garage-door-repair/` | Horsham Garage Door Repair- Xpress Garage Doors Repair Services |

## Navigation aliases and inconsistencies

- Root navigation links `/garage-door-repair-willow-grove-pa-willow-grove-garage-doors/`, while sitemap canonical is `/service-area-all-content/garage-door-repair-willow-grove-pa-willow-grove-garage-doors/`. Support both paths in the redesign.
- `/service-area-all-content/` remains sitemap-listed despite replacement `/service-areas/`. Preserve as an alias.
- `/locations/philadelphila/` is a source URL typo. Preserve redirect/alias while presenting Philadelphia correctly.
- Source label “Central City Philadelphia” refers to Center City business service. Keep URL and recognizable area coverage.
- Service areas cover Philadelphia, Center City, Northeast Philadelphia; Willow Grove, Horsham, Huntingdon Valley, Abington, Glenside, Jenkintown, Elkins Park; Bensalem, Levittown, Newtown, Doylestown, Warminster; Camden NJ and New Orleans/Metairie LA. Dresher is named on About/older home copy without a standalone sitemap page.
- Source has duplicate H1s on multiple newer pages and duplicate footer content on service-areas; redesign should consolidate semantic structure.
- Legacy repair page title mentions Middleton/Delaware and copy mentions Lehigh Valley; current primary area index gives the clearer verified geographic scope. Do not invent additional location pages from stale SEO title fragments.

## Gallery coverage

- `/gallery/` contains a category interface (All / Commercial Doors / Residential Garage Door). Its Elementor gallery images use `data-thumbnail` attributes on divs rather than img tags. These include residential manufacturer/product photographs and commercial project photographs; preserve the difference between inspiration and completed projects.
- `/gallery-page-2/` live returned HTML contains no project img tags; metadata points to banner1.jpg. Elementor data-thumbnail/background attributes should also be inspected before concluding an original gallery is empty.
- `/commercial-jobs-gallery/` contains seven original project photographs, comm1 through comm7, all without source alt text. Largest useful variants up to 1280 px were downloaded to `redesign/dist/assets`.
- Asset mapping: `redesign/dist/assets/gallery-source-inventory.json` records source page, original URL, local filename, original blank alt, category Commercial, and suggested neutral alt. Existing assets were preserved.

## Review/form facts

- Current quote forms collect name, phone, email, city and message. Older home/contact forms also include preferred appointment date/time.
- No verified star average, customer count, warranty duration, fixed pricing, license number, insurance certificate or measured response time was found. Avoid inventing these claims.
- Cached legacy About includes testimonials from Gary E. (Doylestown), Maryellen H. (Levittown), Jim W. (Lansdale); current live About does not show them.

## Local audit artifacts

- Full HTML/text crawl: `/private/tmp/xpress-full-crawl.json` (all 30 pages with text, headings, links).
- Raw HTML files: `/private/tmp/xpress-crawl-*.html`.
- Sitemap snapshots: `/private/tmp/xpress-pages.xml`, `/private/tmp/xpress-posts.xml`.
