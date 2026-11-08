'use strict';
// The demo marketplace: four sample shops and 40 products (clothing and accessories).

const VENDORS = [
  { slug: 'urban-loom',      name: 'Urban Loom',      commissionPercent: 10, description: 'Streetwear essentials: tees, hoodies and joggers made for city life.' },
  { slug: 'heritage-weave',  name: 'Heritage Weave',  commissionPercent: 12, description: 'Panjabis, kurtis and festive wear inspired by Bengali craft.' },
  { slug: 'little-sprouts',  name: 'Little Sprouts',  commissionPercent: 10, description: 'Soft, tough, easy-wash clothes for kids who never sit still.' },
  { slug: 'denim-district',  name: 'Denim District',  commissionPercent: 10, description: 'Jeans, shirts and everyday basics that fit properly.' }
];

const BLURB = {
  tee:     'Soft combed-cotton tee with a comfortable everyday fit. Pre-washed to keep its shape.',
  sweater: 'Warm, midweight knit with ribbed cuffs and hem. Easy layering for cooler days.',
  hoodie:  'Brushed-fleece hoodie with a roomy hood and kangaroo pocket. Soft inside, tough outside.',
  shirt:   'Crisp, breathable button-up with a classic collar and chest pocket. Smart or casual.',
  dress:   'Light, flowing dress that moves well and washes easily. Dress it up or keep it simple.',
  jeans:   'Durable stretch denim with a clean finish and reinforced stitching. Holds its colour wash after wash.',
  joggers: 'Relaxed joggers with an elastic waist, drawstring and ribbed cuffs. Built for comfort.',
  shorts:  'Easy shorts with a comfortable waist and practical pockets. A warm-weather favourite.',
  skirt:   'Pleated skirt with a smooth fall and a comfortable waistband. Pairs with almost anything.',
  kurta:   'Finely finished cotton with a button placket and detailed trim. Made for festivals and special days.',
  tote:    'Sturdy cotton canvas tote with long handles and a roomy main pocket. Carries a day of shopping with ease.',
  cap:     'Soft cotton cap with a curved brim and an adjustable back strap. Easy to wear every day.',
  scarf:   'Warm, soft woven scarf with a fringed edge. Wraps twice for cold days and sits light on mild ones.',
  belt:    'Smooth faux-leather belt with a polished metal buckle and five adjustment holes. Goes with jeans and chinos.'
};

// [slug, title, garment, colour, price, stock, category, shop (null = sold by the store itself),
// kids?]
const ROWS = [
  ['oversized-graphic-tee-charcoal', 'Oversized Graphic Tee - Charcoal', 'tee', '#3b3f46', 899, 40, 'Men', 'urban-loom'],
  ['essential-crew-tee-off-white', 'Essential Crew Tee - Off White', 'tee', '#efe9df', 649, 60, 'Men', 'urban-loom'],
  ['classic-pullover-hoodie-forest', 'Classic Pullover Hoodie - Forest', 'hoodie', '#2f5d50', 2199, 25, 'Men', 'urban-loom'],
  ['oversized-hoodie-dusty-rose', 'Oversized Hoodie - Dusty Rose', 'hoodie', '#d68c8c', 2299, 22, 'Women', 'urban-loom'],
  ['cargo-joggers-olive', 'Cargo Joggers - Olive', 'joggers', '#6b705c', 1799, 30, 'Men', 'urban-loom'],
  ['relaxed-joggers-slate', 'Relaxed Joggers - Slate', 'joggers', '#5b6574', 1599, 28, 'Women', 'urban-loom'],
  ['cropped-boxy-tee-sage', 'Cropped Boxy Tee - Sage', 'tee', '#a3b18a', 749, 35, 'Women', 'urban-loom'],
  ['heavyweight-sweatshirt-mustard', 'Heavyweight Sweatshirt - Mustard', 'sweater', '#d4a72c', 1999, 18, 'Men', 'urban-loom'],
  ['knit-crew-sweater-burgundy', 'Knit Crew Sweater - Burgundy', 'sweater', '#7a2e3a', 2399, 14, 'Women', 'urban-loom'],

  ['embroidered-cotton-panjabi-ivory', 'Embroidered Cotton Panjabi - Ivory', 'kurta', '#f1e8d6', 2499, 20, 'Men', 'heritage-weave'],
  ['festive-panjabi-midnight-blue', 'Festive Panjabi - Midnight Blue', 'kurta', '#1f2a56', 2999, 15, 'Men', 'heritage-weave'],
  ['handloom-panjabi-maroon', 'Handloom Panjabi - Maroon', 'kurta', '#7b2d35', 2799, 12, 'Men', 'heritage-weave'],
  ['printed-cotton-kurti-teal', 'Printed Cotton Kurti - Teal', 'kurta', '#2a7f84', 1699, 26, 'Women', 'heritage-weave'],
  ['block-print-kurti-coral', 'Block Print Kurti - Coral', 'kurta', '#e07a5f', 1899, 22, 'Women', 'heritage-weave'],
  ['pleated-midi-skirt-plum', 'Pleated Midi Skirt - Plum', 'skirt', '#6d3b6e', 1599, 18, 'Women', 'heritage-weave'],
  ['floral-summer-dress-sky', 'Floral Summer Dress - Sky', 'dress', '#8fb8de', 2599, 16, 'Women', 'heritage-weave'],
  ['wrap-style-dress-emerald', 'Wrap-Style Dress - Emerald', 'dress', '#1f7a5c', 3299, 10, 'Women', 'heritage-weave'],

  ['kids-dino-tee-sunny', 'Kids Dino Tee - Sunny Yellow', 'tee', '#f2c94c', 499, 50, 'Kids', 'little-sprouts', true],
  ['kids-everyday-tee-sky', 'Kids Everyday Tee - Sky Blue', 'tee', '#7fb7e6', 449, 60, 'Kids', 'little-sprouts', true],
  ['kids-cozy-hoodie-lilac', 'Kids Cozy Hoodie - Lilac', 'hoodie', '#b39ddb', 1299, 24, 'Kids', 'little-sprouts', true],
  ['kids-play-shorts-navy', 'Kids Play Shorts - Navy', 'shorts', '#2c3e6b', 599, 40, 'Kids', 'little-sprouts', true],
  ['kids-denim-shorts-blue', 'Kids Denim Shorts - Blue', 'shorts', '#5d7fa6', 699, 32, 'Kids', 'little-sprouts', true],
  ['girls-twirl-dress-pink', 'Girls Twirl Dress - Pink', 'dress', '#f4a6c1', 1399, 18, 'Kids', 'little-sprouts', true],
  ['kids-cotton-joggers-grey', 'Kids Cotton Joggers - Grey', 'joggers', '#9aa0a6', 849, 30, 'Kids', 'little-sprouts', true],
  ['kids-knit-sweater-teal', 'Kids Knit Sweater - Teal', 'sweater', '#3a9d8f', 1099, 20, 'Kids', 'little-sprouts', true],

  ['slim-fit-jeans-indigo', 'Slim Fit Jeans - Indigo', 'jeans', '#2f4b7c', 2299, 30, 'Men', 'denim-district'],
  ['straight-jeans-washed-blue', 'Straight Jeans - Washed Blue', 'jeans', '#5b83b0', 2199, 28, 'Men', 'denim-district'],
  ['black-stretch-jeans', 'Black Stretch Jeans', 'jeans', '#23252b', 2399, 24, 'Men', 'denim-district'],
  ['high-rise-skinny-jeans-mid-blue', 'High-Rise Skinny Jeans - Mid Blue', 'jeans', '#4a6fa5', 2399, 26, 'Women', 'denim-district'],
  ['wide-leg-jeans-light-wash', 'Wide-Leg Jeans - Light Wash', 'jeans', '#8fb0d4', 2599, 18, 'Women', 'denim-district'],
  ['oxford-button-up-shirt-sky', 'Oxford Button-Up Shirt - Sky', 'shirt', '#bcd4e6', 1799, 24, 'Men', 'denim-district'],
  ['linen-shirt-sand', 'Linen Shirt - Sand', 'shirt', '#d8c3a5', 1999, 20, 'Men', 'denim-district'],
  ['denim-shorts-women', 'Denim Shorts - Women', 'shorts', '#6c8fbd', 1299, 22, 'Women', 'denim-district'],

  ['essential-white-tee', 'Essential White Tee', 'tee', '#f7f7f5', 599, 80, 'Men', null],
  ['ribbed-tee-oat', 'Ribbed Tee - Oat', 'tee', '#e3d3bf', 649, 60, 'Women', null],
  ['everyday-hoodie-grey', 'Everyday Hoodie - Grey', 'hoodie', '#9a9fa6', 1899, 30, 'Men', null],

  ['canvas-tote-bag-natural', 'Canvas Tote Bag - Natural', 'tote', '#d8c3a5', 799, 40, 'Accessories', null],
  ['cotton-baseball-cap-navy', 'Cotton Baseball Cap - Navy', 'cap', '#2c3e6b', 699, 50, 'Accessories', 'urban-loom'],
  ['wool-blend-scarf-burgundy', 'Wool Blend Scarf - Burgundy', 'scarf', '#7a2e3a', 1199, 30, 'Accessories', 'heritage-weave'],
  ['faux-leather-belt-brown', 'Faux Leather Belt - Brown', 'belt', '#6b4a2f', 999, 35, 'Accessories', 'denim-district']
];

const PRODUCTS = ROWS.map(([slug, title, garment, color, price, stock, category, vendor, kids]) => ({
  slug, title, garment, color, kids: !!kids, vendor, category, price, stock,
  description: BLURB[garment]
}));

module.exports = { VENDORS, PRODUCTS, BLURB };
