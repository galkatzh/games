// content/tlv_center/errands.js — WP-GAME
// The shipped errand set (GAME_DESIGN 6). Text names a business only through {poi}, so no joke attaches to a real shop, and a
// sentence holding {poi} is a plain instruction. tests/game/content.test.mjs enforces both.
(function () {
  'use strict';

  var ERRANDS = [
    {
      id: 'milk', tier: 1, weight: 3,
      target: { kinds: ['convenience', 'supermarket'], named: 'prefer', anchor: { osm: 'n11238493213', at: [32.0749, 34.7820], name: 'Carrefour' } },
      fallbackKinds: [],
      text: { he: 'חלב. לפני הגן.', en: 'Milk. Before the gan.' },
      mod: null
    },
    {
      id: 'dry_cleaning', tier: 1, weight: 3,
      target: { kinds: ['laundry', 'dry_cleaning'], named: 'prefer', anchor: null },
      fallbackKinds: ['convenience'],
      text: {
        he: 'לאסוף את החליפה מ{poi}. החתונה הערב. זו לא החליפה שלך.',
        en: 'Pick up the suit from {poi}. The wedding is tonight. It is not your suit.'
      },
      mod: null
    },
    {
      id: 'bank_queue', tier: 1, weight: 3,
      target: { kinds: ['bank'], named: 'prefer', anchor: null },
      fallbackKinds: [],
      text: { he: 'הבנק צריך אותך באופן אישי. הוא לא אומר למה.', en: 'The bank needs you in person. It will not say why.' },
      mod: null
    },
    {
      id: 'grandma_pills', tier: 2, weight: 3,
      target: { kinds: ['pharmacy'], named: 'prefer', anchor: null },
      fallbackKinds: ['convenience'],
      text: {
        he: 'סבתא צריכה את הכדורים מ{poi}. היא כבר התקשרה פעמיים.',
        en: 'Grandma needs her pills from {poi}. She has already called twice.'
      },
      mod: null
    },
    {
      id: 'birthday_cake', tier: 2, weight: 3,
      target: { kinds: ['bakery'], named: 'prefer', anchor: null },
      fallbackKinds: [],
      text: { he: 'עוגה מ{poi}. הנרות זו הבעיה שלך.', en: 'Cake from {poi}. The candles are your problem.' },
      mod: null
    },
    {
      id: 'haircut_cancel', tier: 2, weight: 3,
      target: { kinds: ['hairdresser'], named: 'prefer', anchor: null },
      fallbackKinds: [],
      text: {
        he: 'לבטל את התספורת ב{poi} באופן אישי. תרגלת את הנאום.',
        en: 'Cancel your haircut at {poi} in person. You have practised the speech.'
      },
      mod: null
    },
    {
      id: 'vegetables', tier: 2, weight: 3,
      target: { kinds: ['greengrocer', 'supermarket'], named: 'prefer', anchor: null },
      fallbackKinds: [],
      text: { he: 'עגבניות מ{poi}. לא העגבניות האלה.', en: 'Tomatoes from {poi}. Not those tomatoes.' },
      mod: null
    },
    {
      id: 'butcher', tier: 3, weight: 3,
      target: { kinds: ['butcher', 'supermarket'], named: 'prefer', anchor: null },
      fallbackKinds: [],
      text: {
        he: 'ההזמנה של חמותך ב{poi}. היא כתבה את הרשימה פעמיים.',
        en: 'Your mother-in-law\'s order at {poi}. She wrote the list twice.'
      },
      mod: null
    },
    {
      id: 'ice_cream', tier: 3, weight: 3,
      target: { kinds: ['ice_cream', 'convenience'], named: 'prefer', anchor: null },
      fallbackKinds: [],
      text: { he: 'גלידה מ{poi}. כן, עכשיו.', en: 'Ice cream from {poi}. Yes, now.' },
      mod: null
    },
    {
      id: 'post_office', tier: 3, weight: 3,
      target: { kinds: ['post_office', 'bank'], named: 'prefer', anchor: null },
      fallbackKinds: [],
      text: { he: 'לאסוף את החבילה. בפתק כתוב שהיית בבית.', en: 'Collect the parcel. The slip says you were home.' },
      mod: null
    },
    {
      id: 'gas_station', tier: 3, weight: 3,
      target: { kinds: ['fuel'], named: 'prefer', anchor: null },
      fallbackKinds: [],
      text: { he: 'לתדלק. הנורה דולקת מאז מרץ.', en: 'Fill up. The light has been on since March.' },
      mod: null
    },
    {
      id: 'gan_pickup', tier: 'finale', weight: 1,
      target: { kinds: 'residential_door', named: 'any', anchor: null },
      fallbackKinds: [],
      text: {
        he: 'הגן נסגר בעוד אחת עשרה דקות. הוא תמיד נסגר בעוד אחת עשרה דקות.',
        en: 'The gan closes in eleven minutes. It always closes in eleven minutes.'
      },
      mod: null
    }
  ];

  ERRANDS.forEach(function (def) {
    TLV.q.push(['errand', def]);
  });
})();
