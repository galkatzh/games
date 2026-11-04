// content/index.js — WP-CORE
// Content list per map (ARCHITECTURE 4.5). A map with no key of its own uses default. Anchored content that does not
// resolve on the current map is an orphan, which is skipped and never an error.
TLV.contentFiles = {
  default: [
    'content/tlv_center/world.js', 'content/tlv_center/errands.js',
    'content/tlv_center/styles.js', 'content/tlv_center/kit.js', 'content/tlv_center/districts.js',
    'content/tlv_center/storefronts.js', 'content/tlv_center/landmarks.js'
  ]
};
// The Ayalon is scenery for this map alone, so a new area gets the default list and needs nothing.
TLV.contentFiles.tlv_center = TLV.contentFiles.default.concat(['content/tlv_center/ayalon.js']);
