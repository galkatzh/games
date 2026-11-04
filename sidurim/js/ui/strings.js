// js/ui/strings.js — WP-UI
// Every word the UI shows, in both languages. [X] in a string is a keycap. The Hebrew is written, not translated: it reads as a
// person from Tel Aviv would say it, and instructions use the infinitive, as signs and parents do, so nothing assumes a gender.
// Hitting a person and a revoked licence are played straight in both languages.
(function (TLV) {
  'use strict';

  var strings = TLV.ns('ui.strings');

  strings.table = {
    en: {
      'title.name': 'SIDURIM',
      'title.sub': 'Errands: Tel Aviv',
      'title.tag': 'Seven errands. One parking spot. Everyone wants it.',
      'title.gan': 'Last errand: picking the kid up from the kindergarten, the gan.',
      'title.start': 'PRESS ANY KEY. THE GAN WILL NOT WAIT.',
      'title.touch': 'THIS GAME NEEDS A KEYBOARD OR A GAMEPAD. TOUCH CANNOT DRIVE IT.',
      'title.pick': 'WHICH TUESDAY WOULD YOU LIKE?',
      'title.pickKeys': '[←] [→] to choose',
      'title.langKey': '[L]',
      'title.langName': 'עברית',
      'title.credits': '[I] Credits',
      'title.best': 'Best day so far: {money}',
      'diff.relaxed.name': 'RELAXED',
      'diff.relaxed.line': 'The clock takes a deep breath. Nobody else does.',
      'diff.normal.name': 'NORMAL',
      'diff.normal.line': 'The gan\'s own clock. Undefeated since Tuesday.',

      'controls.drive': 'drive',
      'controls.steer': 'steer',
      'controls.handbrake': 'handbrake',
      'controls.horn': 'horn',
      'controls.parkBadly': 'park badly',
      'controls.tow': 'tow',
      'controls.camera': 'bay camera',
      'controls.mirror': 'mirror',
      'controls.mute': 'mute',
      'controls.pause': 'pause',

      'pause.title': 'PAUSED',
      'pause.line': 'Everyone behind you is still honking.',
      'pause.resume': '[ESC] back to the balagan',
      'pause.resumePad': '[START] back to the balagan',
      'pause.soundOn': 'Sound on [M]',
      'pause.soundOff': 'Sound off [M]',
      'pause.credits': 'Credits [I]',

      'hud.noClaims': 'NO-CLAIMS',
      'hud.kmh': 'KM/H',
      'hud.chain': 'CHUTZPAH',
      'hud.errand': 'ERRAND {n}/{total}',
      'hud.door': 'door',
      'hud.bay': 'bay',
      'hud.metres': '{n} m',
      'hud.seconds': '{n} s',
      'hud.rage': 'RIVAL\'S RAGE',
      'hud.onFoot': 'ON FOOT',
      'hud.bayTag': 'P',
      'hud.north': 'N',
      'hud.strikes': 'STRIKES',
      'hud.gap': 'HIS GAP',
      'hud.chaseTime': 'INSPECTOR IN',
      'street.unnamed': 'No name. Plenty of opinions.',

      'prompt.drive': '[W] GO   [A] [D] STEER',
      'prompt.launch': 'GREEN! [W] BEFORE THE HONK',
      'prompt.handbrake': '[SPACE] HANDBRAKE THE CORNER',
      'prompt.search': 'SLOW BELOW 25 KM/H, NOSE INTO THE BOX',
      'prompt.missed.BACK': 'MISSED IT. [S] BACK UP',
      'prompt.missed.BACK_OR_Q': 'MISSED IT. [S] BACK UP, OR HOLD [Q]: PARK BADLY',
      'prompt.wait': 'WAIT BEHIND HIM: +5 s',
      'prompt.parkBadly': '[Q]: PARK BADLY',
      'prompt.noBay': 'NOT ONE BAY LEFT. HOLD [Q]: PARK BADLY',
      'prompt.stuck': 'WEDGED? HOLD [R]: TOW, -15 s, -₪100',
      'prompt.blocked': 'HE HAS PARKED ON YOUR FUTURE',

      'park.ARMED': 'CREEP. STRAIGHTEN UP.',
      'park.BRAKE': 'BRAKE. NO ROOM LEFT.',
      'park.STOP': 'THE BAY IS YOURS. NOW STOP.',
      'park.SNAP': 'EASING IN',
      'park.FILL': 'STAY. HANDS OFF THE GAS.',
      'park.CURB': 'HOLD [Q]. IT IS ONLY A KERB.',
      'park.DOUBLE': 'HOLD [Q]. JUST ONE SECOND.',

      'knife.STANDOFF': 'HE IS GETTING OUT OF THE CAR',
      'knife.DOOR_TUG': '[E] OUT THE PASSENGER SIDE',
      'knife.BAIL': 'OUT! RUN!',
      'knife.DRAGGED': 'THE DRIVER\'S SIDE, THEN',
      'knife.CHASE': 'RUN TO THE DOOR. [SPACE] SIDESTEP',
      'knife.CHASE_ROUND': 'RUN TO THE DOOR: GO ROUND. [SPACE] SIDESTEP',
      'chase.lunge': '[SPACE] NOW!',
      'chase.shaken': 'HE LOST INTEREST. KEEP RUNNING.',
      'chase.strike': 'OOF',
      'chase.thisWay': 'THIS WAY',

      'near.1': 'NEAR MISS',
      'near.2': 'BY A HAIR',
      'bonus.BEAT_THE_HONK': 'BEAT THE HONK',
      'bonus.HANDBRAKE_PARK': 'HANDBRAKE PARK',
      'bonus.AFTER_YOU': 'AFTER YOU',
      'bonus.GAVE_WAY': 'GAVE WAY',
      'bonus.SPOTLESS': 'SPOTLESS',
      'bonus.EXIT_REACHED_SHOP': 'MADE IT TO THE SHOP',

      'toast.wrongWay': 'WRONG WAY. ALLEGEDLY.',
      'toast.redRun': 'The camera has been broken since 2019.',
      'toast.water': 'The sea is not a shortcut.',
      'toast.recover': 'Towed back to a road. -15 s, -₪100',
      'toast.recalc.0': 'Recalculating. Disappointed.',
      'toast.recalc.1': 'In 200 metres, regret.',
      'toast.hitPed': 'YOU HIT A PERSON. -₪500, -30 s. THIS ERRAND PAYS NOTHING.',
      'toast.hitPedLast': 'ONE MORE AND THE LICENCE IS GONE.',
      'toast.clock.1': 'Your phone is ringing. It is the gan.',
      'toast.clock.2': 'It is the gan again.',
      'toast.search': 'Somewhere around here. In theory.',
      'toast.cameraFar': 'The bay camera only works near the bay.',
      'toast.qFar': 'Parking badly only works near the door. Get closer, stop, then hold [Q].',
      'error.noGraphics': 'This game needs 3D graphics, and this browser cannot show them right now. Update the browser, or turn on hardware acceleration in its settings.',
      'toast.contestStart': 'SOMEONE ELSE WANTS YOUR SPOT',
      'toast.contestWon': 'HE TOOK IT. NEXT BAY.',
      'toast.curse': 'He has notes on your driving.',
      'toast.block': 'HE IS BLOCKING YOU. HE HAS TIME.',
      'toast.knife': 'OH NO.',
      'toast.ticket': 'TICKET {money}. The inspector was already here. He is always already here.',
      'toast.tow': 'TOW {money}. The tow truck was suspiciously close.',

      'incident.RED_RUNNER': 'HE IS NOT STOPPING',
      'incident.BUS_PULLOUT': 'THE BUS HAS DECIDED',
      'incident.DOOR_ZONE': 'DOOR!',
      'incident.DROP_OFF': 'JUST DROPPING SOMEONE OFF',
      'incident.STOP_NO_REASON': 'STOPPED. NO REASON.',
      'incident.ZEBRA_ROULETTE': 'ZEBRA ROULETTE',
      'incident.SLOW_CROSS': 'IN NO HURRY',
      'incident.RED_WALKER': 'WALKING ON RED',
      'incident.SCOOTER_SALMON': 'SCOOTER, WRONG WAY',
      'incident.DELIVERY_POP': 'DELIVERY, INCOMING',
      'incident.TAILGATE': 'GLUED TO YOUR BUMPER',
      'incident.OVERTAKE_DIVE': 'OVERTAKING, SOMEHOW',
      'incident.MERGE_WEDGE': 'A NOSE IS COMING IN',
      'incident.DOUBLE_PARK': '"JUST ONE SECOND"',
      'incident.REVERSE_FOR_SPOT': 'REVERSING FOR A SPOT',

      'card.message': 'New message',
      'card.sender': 'Family group',
      'card.at': 'Target: {name}',
      'card.route': 'To the bay: {n} m by road, on a good day',

      'quality.PERFECT': 'PERFECT',
      'quality.GOOD': 'GOOD',
      'quality.UGLY': 'UGLY',
      'quality.DOUBLE': 'DOUBLE-PARKED',
      'qualityLine.PERFECT': 'Your driving instructor wept.',
      'qualityLine.GOOD': 'Mostly between the lines.',
      'qualityLine.UGLY': 'Parked. Legally, even. Probably.',
      'qualityLine.DOUBLE': 'Hazards on, so it must be fine.',
      'qualityWhy.OFFSET': 'Too far off centre. Stop in the middle of the box.',
      'qualityWhy.CROOKED': 'Too crooked. Straighten up before you stop.',
      'qualityWhy.ANY': 'Crooked or off centre. Stop straight, in the middle of the box.',
      'qualityWhy.CURB': 'A red kerb never scores better. A marked bay can.',
      'payout.title': 'PARKED',
      'payout.pay': 'PAY',
      'payout.time': 'CLOCK',
      'payout.pending': 'Pay when this is over',
      'payout.none': 'This errand pays nothing.',
      'payout.spotless': 'SPOTLESS +8 s, +10 NO-CLAIMS',

      'block.title': 'BLOCKED',
      'block.line': 'He is shouting. It is all symbols.',

      'resolve.REACHED_SHOP.title': 'YOU REACHED THE SHOP',
      'resolve.REACHED_SHOP.line': 'He is explaining the law to an inspector. The inspector is explaining it back.',
      'resolve.SHAKEN.title': 'HE LOST INTEREST',
      'resolve.SHAKEN.line': 'He has a new enemy now. It wears a reflective vest.',
      'resolve.WHISTLE.title': 'SAVED BY THE WHISTLE',
      'resolve.WHISTLE.line': 'His car got a ticket. He ran for it. The tow truck ran faster.',
      'resolve.skip': 'Any key',

      'end.licence': 'DRIVING LICENCE',
      'end.licenceClass': 'Class: Tuesday',
      'end.rank': 'RANK',
      'end.total': 'TOTAL',
      'end.best': 'Best day: {money}',
      'end.newBest': 'NEW BEST DAY',
      'end.restart': '[ENTER] OR [R]: ANOTHER TUESDAY',
      'end.restartRevoked': '[ENTER] OR [R]: START AGAIN',
      'end.difficulty': 'Next Tuesday:',
      'end.difficultyPlain': 'Difficulty:',
      'lost.title': 'THE PICTURE DROPPED OUT',
      'lost.wait': 'The clock is stopped. It usually comes back by itself.',
      'lost.reload': 'Still nothing. Reloading starts the day again.',
      'lost.button': 'RELOAD',
      'end.CLOCK.title': 'OUT OF TIME',
      'end.CLOCK.line': 'The gan called. Again.',
      'end.TOWED.title': 'TOWED',
      'end.TOWED.line': 'Your car has been reassigned.',
      'end.CAUGHT.title': 'CAUGHT',
      'end.CAUGHT.line': 'You wake on a bench. There is a parking ticket under your shoe.',
      'end.REVOKED.title': 'LICENCE REVOKED',
      'end.REVOKED.line': '',
      'end.WIN.title': 'SEVEN FOR SEVEN',
      'end.WIN.line': 'You survived Tuesday.',
      'end.CLOCK.stamp': 'LATE',
      'end.TOWED.stamp': 'TOWED',
      'end.CAUGHT.stamp': 'CAUGHT',
      'end.REVOKED.stamp': 'REVOKED',
      'end.WIN.stamp': 'DONE',

      'rank.NEW_DRIVER': 'NEW DRIVER',
      'rank.BUS_DRIVER': 'BUS DRIVER',
      'rank.TAXI_DRIVER': 'TAXI DRIVER',
      'rank.DELIVERY_RIDER': 'DELIVERY RIDER',
      'rank.LEGEND': 'LEGEND OF IBN GABIROL',

      'tally.honksReceived': 'Honks received',
      'tally.spotsStolen': 'Spots stolen',
      'tally.nearMisses': 'Near misses',
      'tally.contacts': 'Contacts',
      'tally.errandsDone': 'Errands done',
      'credits.title': 'CREDITS',
      'credits.map': 'Map data',
      'credits.mapLine': 'Available under the',
      'credits.engine': 'Engine',
      'credits.art': 'Packed art',
      'credits.noArt': 'None in this build. The game draws everything you see.',
      'credits.own': 'own work',
      'credits.unknown': 'no credit on record',
      'credits.back': '[ESC] Back',

      'error.title': 'Something fell off the back of the build',
      'error.close': 'Close'
    },

    he: {
      'title.name': 'סידורים',
      'title.sub': 'יום אחד בתל אביב',
      'title.tag': 'שבעה סידורים. חניה אחת. כולם רוצים אותה.',
      'title.gan': 'הסידור האחרון: לאסוף את הילד מהגן.',
      'title.start': 'כל מקש. הגן לא מחכה.',
      'title.touch': 'המשחק דורש מקלדת או שלט משחק. במגע אי אפשר לנהוג.',
      'title.pick': 'איזה יום שלישי בא לך?',
      'title.pickKeys': '[←] [→] לבחירה',
      'title.langKey': '[L]',
      'title.langName': 'English',
      'title.credits': '[I] קרדיטים',
      'title.best': 'היום הכי טוב עד עכשיו: {money}',
      'diff.relaxed.name': 'רגוע',
      'diff.relaxed.line': 'השעון נושם עמוק. אף אחד אחר לא.',
      'diff.normal.name': 'רגיל',
      'diff.normal.line': 'השעון של הגן. לא הפסיד מאז יום שלישי.',

      'controls.drive': 'נסיעה',
      'controls.steer': 'הגה',
      'controls.handbrake': 'בלם יד',
      'controls.horn': 'צפירה',
      'controls.parkBadly': 'לחנות על הפנים',
      'controls.tow': 'גרר',
      'controls.camera': 'מצלמת חניה',
      'controls.mirror': 'מראה',
      'controls.mute': 'שקט',
      'controls.pause': 'הפסקה',

      'pause.title': 'הפסקה',
      'pause.line': 'כולם מאחורה עדיין צופרים.',
      'pause.resume': '[ESC] חזרה לבלגן',
      'pause.resumePad': '[START] חזרה לבלגן',
      'pause.soundOn': 'סאונד פועל [M]',
      'pause.soundOff': 'סאונד כבוי [M]',
      'pause.credits': 'קרדיטים [I]',

      'hud.noClaims': 'ללא תביעות',
      'hud.kmh': 'קמ״ש',
      'hud.chain': 'חוצפה',
      'hud.errand': 'סידור {n}/{total}',
      'hud.door': 'דלת',
      'hud.bay': 'חניה',
      'hud.metres': '{n} מ׳',
      'hud.seconds': '{n} שנ׳',
      'hud.rage': 'העצבים של היריב',
      'hud.onFoot': 'ברגל',
      'hud.bayTag': 'P',
      'hud.north': 'צ',
      'hud.strikes': 'פגיעות',
      'hud.gap': 'המרחק ממנו',
      'hud.chaseTime': 'הפקח בעוד',
      'street.unnamed': 'בלי שם. עם הרבה דעות.',

      'prompt.drive': '[W] גז   [A] [D] הגה',
      'prompt.launch': 'ירוק! [W] לפני הצפירה',
      'prompt.handbrake': '[SPACE] בלם יד בסיבוב',
      'prompt.search': 'מתחת ל־25 קמ״ש, האף לתוך המשבצת',
      'prompt.missed.BACK': 'פספסת. [S] רוורס',
      'prompt.missed.BACK_OR_Q': 'פספסת. [S] רוורס, או להחזיק [Q] ולחנות על הפנים',
      'prompt.wait': 'לחכות מאחוריו: +5 שניות',
      'prompt.parkBadly': '[Q]: לחנות על הפנים',
      'prompt.noBay': 'אין חניה בכל העיר. להחזיק [Q]: לחנות על הפנים',
      'prompt.stuck': 'נתקעת? להחזיק [R]: גרר, -15 שניות, -₪100',
      'prompt.blocked': 'הוא חנה לך על העתיד',

      'park.ARMED': 'לזחול. ליישר.',
      'park.BRAKE': 'לבלום. נגמר המקום.',
      'park.STOP': 'החניה שלך. עכשיו לעצור.',
      'park.SNAP': 'נכנסים לאט',
      'park.FILL': 'לא לזוז. רגל מהגז.',
      'park.CURB': 'להחזיק [Q]. זו רק מדרכה.',
      'park.DOUBLE': 'להחזיק [Q]. רק שנייה.',

      'knife.STANDOFF': 'הוא יוצא מהאוטו',
      'knife.DOOR_TUG': '[E] החוצה מצד הנוסע',
      'knife.BAIL': 'בחוץ! לרוץ!',
      'knife.DRAGGED': 'טוב, אז מצד הנהג',
      'knife.CHASE': 'לרוץ לדלת. [SPACE] להתחמק',
      'knife.CHASE_ROUND': 'לרוץ לדלת: להקיף. [SPACE] להתחמק',
      'chase.lunge': '[SPACE] עכשיו!',
      'chase.shaken': 'נמאס לו. להמשיך לרוץ.',
      'chase.strike': 'אוף',
      'chase.thisWay': 'מכאן',

      'near.1': 'כמעט',
      'near.2': 'כחוט השערה',
      'bonus.BEAT_THE_HONK': 'ניצחת את הצפירה',
      'bonus.HANDBRAKE_PARK': 'חניית בלם יד',
      'bonus.AFTER_YOU': 'בכיף, אחריך',
      'bonus.GAVE_WAY': 'נתת זכות קדימה',
      'bonus.SPOTLESS': 'בלי שריטה',
      'bonus.EXIT_REACHED_SHOP': 'הגעת לחנות',

      'toast.wrongWay': 'נגד התנועה. לכאורה.',
      'toast.redRun': 'המצלמה מקולקלת מאז 2019.',
      'toast.water': 'הים זה לא קיצור דרך.',
      'toast.recover': 'גרר החזיר אותך לכביש. -15 שניות, -₪100',
      'toast.recalc.0': 'מחשב מסלול מחדש. באכזבה.',
      'toast.recalc.1': 'בעוד 200 מטר, חרטה.',
      'toast.hitPed': 'פגעת באדם. -₪500, -30 שניות. הסידור הזה בלי תשלום.',
      'toast.hitPedLast': 'עוד פעם אחת והרישיון נשלל.',
      'toast.clock.1': 'הטלפון מצלצל. זה מהגן.',
      'toast.clock.2': 'שוב מהגן.',
      'toast.search': 'איפשהו פה. בתיאוריה.',
      'toast.cameraFar': 'מצלמת החניה עובדת רק ליד החניה.',
      'toast.qFar': 'לחנות על הפנים אפשר רק ליד הדלת. להתקרב, לעצור, ואז להחזיק [Q].',
      'error.noGraphics': 'המשחק צריך גרפיקה תלת־ממדית, והדפדפן הזה לא מצליח להציג אותה כרגע. אפשר לעדכן את הדפדפן, או להפעיל האצת חומרה בהגדרות שלו.',
      'toast.contestStart': 'מישהו אחר רוצה את החניה שלך',
      'toast.contestWon': 'הוא לקח אותה. לחניה הבאה.',
      'toast.curse': 'יש לו הערות על הנהיגה.',
      'toast.block': 'הוא חוסם אותך. יש לו זמן.',
      'toast.knife': 'אוי לא.',
      'toast.ticket': 'דו״ח {money}. הפקח כבר היה פה. הוא תמיד כבר פה.',
      'toast.tow': 'גרר {money}. הגרר היה קרוב באופן חשוד.',

      'incident.RED_RUNNER': 'הוא לא עוצר',
      'incident.BUS_PULLOUT': 'האוטובוס החליט',
      'incident.DOOR_ZONE': 'דלת!',
      'incident.DROP_OFF': 'רק מוריד מישהו',
      'incident.STOP_NO_REASON': 'עצר. ככה.',
      'incident.ZEBRA_ROULETTE': 'רולטה במעבר חצייה',
      'incident.SLOW_CROSS': 'לא ממהרים לשום מקום',
      'incident.RED_WALKER': 'הולך על אדום',
      'incident.SCOOTER_SALMON': 'קורקינט נגד הכיוון',
      'incident.DELIVERY_POP': 'שליח בדרך',
      'incident.TAILGATE': 'דבוק לך לפגוש',
      'incident.OVERTAKE_DIVE': 'עקיפה, איכשהו',
      'incident.MERGE_WEDGE': 'מישהו דוחף את האף',
      'incident.DOUBLE_PARK': '״רק שנייה״',
      'incident.REVERSE_FOR_SPOT': 'ברוורס בשביל חניה',

      'card.message': 'הודעה חדשה',
      'card.sender': 'קבוצת המשפחה',
      'card.at': 'יעד: {name}',
      'card.route': 'עד החניה: {n} מ׳ בכביש, ביום טוב',

      'quality.PERFECT': 'מושלם',
      'quality.GOOD': 'טוב',
      'quality.UGLY': 'מכוער',
      'quality.DOUBLE': 'חניה כפולה',
      'qualityLine.PERFECT': 'המורה לנהיגה התרגש עד דמעות.',
      'qualityLine.GOOD': 'רוב האוטו בתוך הקווים.',
      'qualityLine.UGLY': 'חנית. אפילו חוקי. כנראה.',
      'qualityLine.DOUBLE': 'ארבעה וינקרים. זה אומר שמותר, לא?',
      'qualityWhy.OFFSET': 'רחוק מדי מהאמצע. לעצור באמצע המשבצת.',
      'qualityWhy.CROOKED': 'עקום מדי. ליישר לפני שעוצרים.',
      'qualityWhy.ANY': 'עקום או רחוק מהאמצע. לעצור ישר, באמצע המשבצת.',
      'qualityWhy.CURB': 'על מדרכה אדומה אין ציון גבוה יותר. במשבצת יש.',
      'payout.title': 'חנית',
      'payout.pay': 'תשלום',
      'payout.time': 'שעון',
      'payout.pending': 'התשלום כשזה ייגמר',
      'payout.none': 'הסידור הזה בלי תשלום.',
      'payout.spotless': 'בלי שריטה: +8 שניות, +10 ללא תביעות',

      'block.title': 'חסום',
      'block.line': 'הוא צועק. הכול בסימנים.',

      'resolve.REACHED_SHOP.title': 'הגעת לחנות',
      'resolve.REACHED_SHOP.line': 'הוא מסביר לפקח את החוק. הפקח מסביר לו בחזרה.',
      'resolve.SHAKEN.title': 'נמאס לו',
      'resolve.SHAKEN.line': 'יש לו אויב חדש עכשיו. עם וסט זוהר.',
      'resolve.WHISTLE.title': 'ניצלת בשריקה',
      'resolve.WHISTLE.line': 'האוטו שלו חטף דו״ח. הוא רץ אליו. הגרר רץ מהר יותר.',
      'resolve.skip': 'כל מקש',

      'end.licence': 'רישיון נהיגה',
      'end.licenceClass': 'סוג: יום שלישי',
      'end.rank': 'דרגה',
      'end.total': 'סך הכול',
      'end.best': 'היום הכי טוב: {money}',
      'end.newBest': 'שיא חדש',
      'end.restart': '[ENTER] או [R]: עוד יום שלישי',
      'end.restartRevoked': '[ENTER] או [R]: להתחיל מחדש',
      'end.difficulty': 'יום שלישי הבא:',
      'end.difficultyPlain': 'רמת קושי:',
      'lost.title': 'התמונה נפלה',
      'lost.wait': 'השעון עצור. בדרך כלל זה חוזר לבד.',
      'lost.reload': 'עדיין כלום. טעינה מחדש תתחיל את היום מהתחלה.',
      'lost.button': 'טעינה מחדש',
      'end.CLOCK.title': 'נגמר הזמן',
      'end.CLOCK.line': 'הגן התקשר. שוב.',
      'end.TOWED.title': 'נגרר',
      'end.TOWED.line': 'הרכב שלך שובץ מחדש.',
      'end.CAUGHT.title': 'נתפסת',
      'end.CAUGHT.line': 'התעוררת על ספסל. יש דו״ח חניה מתחת לנעל.',
      'end.REVOKED.title': 'הרישיון נשלל',
      'end.REVOKED.line': '',
      'end.WIN.title': 'שבעה מתוך שבעה',
      'end.WIN.line': 'שרדת את יום שלישי.',
      'end.CLOCK.stamp': 'באיחור',
      'end.TOWED.stamp': 'נגרר',
      'end.CAUGHT.stamp': 'נתפס',
      'end.REVOKED.stamp': 'נשלל',
      'end.WIN.stamp': 'בוצע',

      'rank.NEW_DRIVER': 'נהג חדש',
      'rank.BUS_DRIVER': 'נהג אוטובוס',
      'rank.TAXI_DRIVER': 'נהג מונית',
      'rank.DELIVERY_RIDER': 'שליח',
      'rank.LEGEND': 'אגדת אבן גבירול',

      'tally.honksReceived': 'צפירות שחטפת',
      'tally.spotsStolen': 'חניות שגנבת',
      'tally.nearMisses': 'כמעט תאונות',
      'tally.contacts': 'נגיעות',
      'tally.errandsDone': 'סידורים שנסגרו',
      'credits.title': 'קרדיטים',
      'credits.map': 'נתוני המפה',
      'credits.mapLine': 'זמינים ברישיון',
      'credits.engine': 'מנוע',
      'credits.art': 'גרפיקה ארוזה',
      'credits.noArt': 'אין במהדורה הזו. כל מה שרואים המשחק מצייר בעצמו.',
      'credits.own': 'יצירה מקורית',
      'credits.unknown': 'אין קרדיט רשום',
      'credits.back': '[ESC] חזרה',

      'error.title': 'משהו נפל מהמשאית',
      'error.close': 'סגירה'
    }
  };

  /** Keycaps of the one-line controls reference, with the string that labels each group. */
  strings.controls = [
    { keys: ['W', 'S'], label: 'controls.drive' },
    { keys: ['A', 'D'], label: 'controls.steer' },
    { keys: ['SPACE'], label: 'controls.handbrake' },
    { keys: ['H'], label: 'controls.horn' },
    { keys: ['Q'], label: 'controls.parkBadly' },
    { keys: ['R'], label: 'controls.tow' },
    { keys: ['C'], label: 'controls.camera' },
    { keys: ['V'], label: 'controls.mirror' },
    { keys: ['M'], label: 'controls.mute' },
    { keys: ['ESC'], label: 'controls.pause' }
  ];

  /**
   * The line for a bay being taken. While it is armed the car has not been graded, so the line follows the grade capture would lock now:
   * it says stop only once stopping would score GOOD or better, and a car still at its worst angle hears to keep going.
   * @param {object} park S.game.park.
   * @returns {string} A string key.
   */
  strings.parkKey = function (park) {
    if (park.stage && park.stage !== 'ARMED') return 'park.' + park.stage;
    return park.would === 'GOOD' || park.would === 'PERFECT' ? 'park.STOP' : 'park.ARMED';
  };

  /** The contract's attribution, the same words in every language. */
  strings.OSM = '© OpenStreetMap contributors';

  /** What the credits view names in its own words, the same in every language. Plain text: the view never fetches anything. */
  strings.CREDITS = {
    odbl: 'Open Database License (ODbL 1.0)',
    osmUrl: 'www.openstreetmap.org/copyright',
    three: 'Three.js r159',
    threeLine: '© 2010-2023 Three.js Authors. MIT License',
    licences: { cc0: 'CC0', 'cc-by-sa': 'CC BY-SA' }
  };

  var LRI = '⁦';
  var PDI = '⁩';

  /** A signed sum or time: it must read left to right inside Hebrew, or the minus lands on the wrong side. */
  var NUMBERISH = /[-+]?₪?\d(?:[\d,.:/]*\d)?/g;

  var lang = 'en';

  /** @returns {string} The current language. */
  strings.lang = function () {
    return lang;
  };

  /** @param {string} next 'en' or 'he'. @returns {string} The language now in force. */
  strings.setLang = function (next) {
    if (strings.table[next]) lang = next;
    return lang;
  };

  /** Holds each number together as one left-to-right island. Plain Latin text has no need of it. */
  strings.isolate = function (text) {
    if (lang !== 'he') return text;
    return text.replace(NUMBERISH, function (m) { return LRI + m + PDI; });
  };

  /**
   * Looks a string up in the current language.
   * @param {string} key Table key.
   * @param {object} [vars] {name} substitutions.
   * @returns {string} Display text. An unknown key is returned as it stands, so a miss shows instead of an empty box.
   */
  strings.t = function (key, vars) {
    var text = strings.table[lang][key];
    if (text === undefined) text = strings.table.en[key];
    if (text === undefined) return key;
    if (vars) {
      text = text.replace(/\{(\w+)\}/g, function (m, name) {
        return vars[name] === undefined ? m : String(vars[name]);
      });
    }
    return strings.isolate(text);
  };

  /** @param {number} n Shekels. @returns {string} Grouped, with the sign in front. */
  strings.money = function (n) {
    var v = Math.round(n);
    var body = '₪' + Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return v < 0 ? '-' + body : body;
  };

  /** @param {number} n Shekels. @returns {string} As money, with a plus for a gain. */
  strings.signedMoney = function (n) {
    return (n > 0 ? '+' : '') + strings.money(n);
  };

  /**
   * Pieces of a string with [X] keycaps, for a renderer to turn into elements.
   * @param {string} text Display text.
   * @returns {Array<{key:boolean,text:string}>} Parts in reading order.
   */
  strings.parts = function (text) {
    var out = [];
    var at = 0;
    var re = /\[([^\]]+)\]/g;
    var m = re.exec(text);
    while (m) {
      if (m.index > at) out.push({ key: false, text: text.slice(at, m.index) });
      out.push({ key: true, text: m[1] });
      at = m.index + m[0].length;
      m = re.exec(text);
    }
    if (at < text.length) out.push({ key: false, text: text.slice(at) });
    return out;
  };
})(window.TLV);
