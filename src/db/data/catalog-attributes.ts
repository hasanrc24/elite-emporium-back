/**
 * Reusable catalog attributes seeded on every installation (BR-CAT-001).
 *
 * Size and color create variants; fabric and occasion are product-level
 * filters (BR-CAT-004). Keys are stable: storefront filters (`attr=size:M`),
 * size-chart rules and variant attribute JSON all refer to them. Owners can
 * add, rename or deactivate values in the admin later.
 */

type AttributeValueSeed = { en: string; bn: string; hex?: string };
type AttributeSeed = {
  key: string;
  type: "select" | "color";
  variation: boolean;
  label: { en: string; bn: string };
  values: AttributeValueSeed[];
};

export const catalogAttributeSeeds: AttributeSeed[] = [
  {
    key: "size",
    type: "select",
    variation: true,
    label: { en: "Size", bn: "সাইজ" },
    values: [
      { en: "XS", bn: "XS" },
      { en: "S", bn: "S" },
      { en: "M", bn: "M" },
      { en: "L", bn: "L" },
      { en: "XL", bn: "XL" },
      { en: "XXL", bn: "XXL" },
      { en: "Free Size", bn: "ফ্রি সাইজ" },
    ],
  },
  {
    key: "color",
    type: "color",
    variation: true,
    label: { en: "Color", bn: "রং" },
    values: [
      { en: "Black", bn: "কালো", hex: "#111111" },
      { en: "White", bn: "সাদা", hex: "#ffffff" },
      { en: "Off White", bn: "অফ হোয়াইট", hex: "#f4efe6" },
      { en: "Red", bn: "লাল", hex: "#c62828" },
      { en: "Maroon", bn: "মেরুন", hex: "#6d1a2a" },
      { en: "Pink", bn: "গোলাপি", hex: "#e58fae" },
      { en: "Peach", bn: "পিচ", hex: "#f4b99a" },
      { en: "Orange", bn: "কমলা", hex: "#e8772e" },
      { en: "Yellow", bn: "হলুদ", hex: "#e9c13b" },
      { en: "Green", bn: "সবুজ", hex: "#3f7d4e" },
      { en: "Olive", bn: "জলপাই", hex: "#6b6b2f" },
      { en: "Blue", bn: "নীল", hex: "#2f5fa8" },
      { en: "Navy", bn: "নেভি", hex: "#1c2a4a" },
      { en: "Purple", bn: "বেগুনি", hex: "#6a3d8f" },
      { en: "Beige", bn: "বেইজ", hex: "#d8c3a5" },
      { en: "Brown", bn: "বাদামি", hex: "#7a4e2d" },
      { en: "Grey", bn: "ধূসর", hex: "#8a8d93" },
      { en: "Golden", bn: "সোনালি", hex: "#c9a24a" },
      { en: "Multicolor", bn: "মাল্টিকালার" },
    ],
  },
  {
    key: "fabric",
    type: "select",
    variation: false,
    label: { en: "Fabric", bn: "কাপড়" },
    values: [
      { en: "Cotton", bn: "সুতি" },
      { en: "Lawn", bn: "লন" },
      { en: "Linen", bn: "লিনেন" },
      { en: "Silk", bn: "সিল্ক" },
      { en: "Georgette", bn: "জর্জেট" },
      { en: "Chiffon", bn: "শিফন" },
      { en: "Muslin", bn: "মসলিন" },
      { en: "Jamdani", bn: "জামদানি" },
      { en: "Khadi", bn: "খাদি" },
      { en: "Viscose", bn: "ভিসকস" },
    ],
  },
  {
    key: "occasion",
    type: "select",
    variation: false,
    label: { en: "Occasion", bn: "উপলক্ষ" },
    values: [
      { en: "Everyday", bn: "প্রতিদিন" },
      { en: "Office", bn: "অফিস" },
      { en: "Party", bn: "পার্টি" },
      { en: "Wedding", bn: "বিয়ে" },
      { en: "Eid", bn: "ঈদ" },
      { en: "Puja", bn: "পূজা" },
    ],
  },
];
