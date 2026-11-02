/**
 * Bangladesh address hierarchy seeded into `bd_locations` (BE-SHIP-004).
 *
 * All divisions and districts are included. Thanas are seeded for Dhaka
 * district (metropolitan thanas plus its upazilas), where delivery charges
 * differ inside one district; elsewhere the district decides the zone and the
 * customer types the area/upazila. More thanas can be added later without
 * changing codes already referenced by orders.
 */

type LocationSeed = {
  code: string;
  level: "division" | "district" | "thana";
  parentCode: string | null;
  nameEn: string;
  nameBn: string;
  zoneCode: string | null;
};

const divisions: [string, string, string][] = [
  ["barishal", "Barishal", "বরিশাল"],
  ["chattogram", "Chattogram", "চট্টগ্রাম"],
  ["dhaka", "Dhaka", "ঢাকা"],
  ["khulna", "Khulna", "খুলনা"],
  ["mymensingh", "Mymensingh", "ময়মনসিংহ"],
  ["rajshahi", "Rajshahi", "রাজশাহী"],
  ["rangpur", "Rangpur", "রংপুর"],
  ["sylhet", "Sylhet", "সিলেট"],
];

const districts: Record<string, [string, string, string][]> = {
  barishal: [
    ["barguna", "Barguna", "বরগুনা"],
    ["barishal", "Barishal", "বরিশাল"],
    ["bhola", "Bhola", "ভোলা"],
    ["jhalokati", "Jhalokati", "ঝালকাঠি"],
    ["patuakhali", "Patuakhali", "পটুয়াখালী"],
    ["pirojpur", "Pirojpur", "পিরোজপুর"],
  ],
  chattogram: [
    ["bandarban", "Bandarban", "বান্দরবান"],
    ["brahmanbaria", "Brahmanbaria", "ব্রাহ্মণবাড়িয়া"],
    ["chandpur", "Chandpur", "চাঁদপুর"],
    ["chattogram", "Chattogram", "চট্টগ্রাম"],
    ["cumilla", "Cumilla", "কুমিল্লা"],
    ["coxs-bazar", "Cox's Bazar", "কক্সবাজার"],
    ["feni", "Feni", "ফেনী"],
    ["khagrachhari", "Khagrachhari", "খাগড়াছড়ি"],
    ["lakshmipur", "Lakshmipur", "লক্ষ্মীপুর"],
    ["noakhali", "Noakhali", "নোয়াখালী"],
    ["rangamati", "Rangamati", "রাঙ্গামাটি"],
  ],
  dhaka: [
    ["dhaka", "Dhaka", "ঢাকা"],
    ["faridpur", "Faridpur", "ফরিদপুর"],
    ["gazipur", "Gazipur", "গাজীপুর"],
    ["gopalganj", "Gopalganj", "গোপালগঞ্জ"],
    ["kishoreganj", "Kishoreganj", "কিশোরগঞ্জ"],
    ["madaripur", "Madaripur", "মাদারীপুর"],
    ["manikganj", "Manikganj", "মানিকগঞ্জ"],
    ["munshiganj", "Munshiganj", "মুন্সিগঞ্জ"],
    ["narayanganj", "Narayanganj", "নারায়ণগঞ্জ"],
    ["narsingdi", "Narsingdi", "নরসিংদী"],
    ["rajbari", "Rajbari", "রাজবাড়ী"],
    ["shariatpur", "Shariatpur", "শরীয়তপুর"],
    ["tangail", "Tangail", "টাঙ্গাইল"],
  ],
  khulna: [
    ["bagerhat", "Bagerhat", "বাগেরহাট"],
    ["chuadanga", "Chuadanga", "চুয়াডাঙ্গা"],
    ["jashore", "Jashore", "যশোর"],
    ["jhenaidah", "Jhenaidah", "ঝিনাইদহ"],
    ["khulna", "Khulna", "খুলনা"],
    ["kushtia", "Kushtia", "কুষ্টিয়া"],
    ["magura", "Magura", "মাগুরা"],
    ["meherpur", "Meherpur", "মেহেরপুর"],
    ["narail", "Narail", "নড়াইল"],
    ["satkhira", "Satkhira", "সাতক্ষীরা"],
  ],
  mymensingh: [
    ["jamalpur", "Jamalpur", "জামালপুর"],
    ["mymensingh", "Mymensingh", "ময়মনসিংহ"],
    ["netrokona", "Netrokona", "নেত্রকোণা"],
    ["sherpur", "Sherpur", "শেরপুর"],
  ],
  rajshahi: [
    ["bogura", "Bogura", "বগুড়া"],
    ["chapainawabganj", "Chapainawabganj", "চাঁপাইনবাবগঞ্জ"],
    ["joypurhat", "Joypurhat", "জয়পুরহাট"],
    ["naogaon", "Naogaon", "নওগাঁ"],
    ["natore", "Natore", "নাটোর"],
    ["pabna", "Pabna", "পাবনা"],
    ["rajshahi", "Rajshahi", "রাজশাহী"],
    ["sirajganj", "Sirajganj", "সিরাজগঞ্জ"],
  ],
  rangpur: [
    ["dinajpur", "Dinajpur", "দিনাজপুর"],
    ["gaibandha", "Gaibandha", "গাইবান্ধা"],
    ["kurigram", "Kurigram", "কুড়িগ্রাম"],
    ["lalmonirhat", "Lalmonirhat", "লালমনিরহাট"],
    ["nilphamari", "Nilphamari", "নীলফামারী"],
    ["panchagarh", "Panchagarh", "পঞ্চগড়"],
    ["rangpur", "Rangpur", "রংপুর"],
    ["thakurgaon", "Thakurgaon", "ঠাকুরগাঁও"],
  ],
  sylhet: [
    ["habiganj", "Habiganj", "হবিগঞ্জ"],
    ["moulvibazar", "Moulvibazar", "মৌলভীবাজার"],
    ["sunamganj", "Sunamganj", "সুনামগঞ্জ"],
    ["sylhet", "Sylhet", "সিলেট"],
  ],
};

// Districts that border Dhaka city and are usually charged as a suburb.
const suburbDistricts = new Set(["gazipur", "narayanganj"]);

const dhakaCityThanas: [string, string, string][] = [
  ["adabor", "Adabor", "আদাবর"],
  ["badda", "Badda", "বাড্ডা"],
  ["banani", "Banani", "বনানী"],
  ["bangshal", "Bangshal", "বংশাল"],
  ["bhashantek", "Bhashantek", "ভাষানটেক"],
  ["bhatara", "Bhatara (Vatara)", "ভাটারা"],
  ["biman-bandar", "Biman Bandar", "বিমানবন্দর"],
  ["cantonment", "Cantonment", "ক্যান্টনমেন্ট"],
  ["chawkbazar", "Chawkbazar", "চকবাজার"],
  ["dakshinkhan", "Dakshinkhan", "দক্ষিণখান"],
  ["darus-salam", "Darus Salam", "দারুস সালাম"],
  ["demra", "Demra", "ডেমরা"],
  ["dhanmondi", "Dhanmondi", "ধানমন্ডি"],
  ["gendaria", "Gendaria", "গেন্ডারিয়া"],
  ["gulshan", "Gulshan", "গুলশান"],
  ["hatirjheel", "Hatirjheel", "হাতিরঝিল"],
  ["hazaribagh", "Hazaribagh", "হাজারীবাগ"],
  ["jatrabari", "Jatrabari", "যাত্রাবাড়ী"],
  ["kadamtali", "Kadamtali", "কদমতলী"],
  ["kafrul", "Kafrul", "কাফরুল"],
  ["kalabagan", "Kalabagan", "কলাবাগান"],
  ["kamrangirchar", "Kamrangirchar", "কামরাঙ্গীরচর"],
  ["khilgaon", "Khilgaon", "খিলগাঁও"],
  ["khilkhet", "Khilkhet", "খিলক্ষেত"],
  ["kotwali", "Kotwali", "কোতোয়ালী"],
  ["lalbagh", "Lalbagh", "লালবাগ"],
  ["mirpur", "Mirpur", "মিরপুর"],
  ["mohammadpur", "Mohammadpur", "মোহাম্মদপুর"],
  ["motijheel", "Motijheel", "মতিঝিল"],
  ["mugda", "Mugda", "মুগদা"],
  ["new-market", "New Market", "নিউমার্কেট"],
  ["pallabi", "Pallabi", "পল্লবী"],
  ["paltan", "Paltan", "পল্টন"],
  ["ramna", "Ramna", "রমনা"],
  ["rampura", "Rampura", "রামপুরা"],
  ["rupnagar", "Rupnagar", "রূপনগর"],
  ["sabujbagh", "Sabujbagh", "সবুজবাগ"],
  ["shah-ali", "Shah Ali", "শাহ আলী"],
  ["shahbagh", "Shahbagh", "শাহবাগ"],
  ["shahjahanpur", "Shahjahanpur", "শাহজাহানপুর"],
  ["sher-e-bangla-nagar", "Sher-e-Bangla Nagar", "শেরেবাংলা নগর"],
  ["shyampur", "Shyampur", "শ্যামপুর"],
  ["sutrapur", "Sutrapur", "সূত্রাপুর"],
  ["tejgaon", "Tejgaon", "তেজগাঁও"],
  ["tejgaon-industrial", "Tejgaon Industrial Area", "তেজগাঁও শিল্পাঞ্চল"],
  ["turag", "Turag", "তুরাগ"],
  ["uttara-east", "Uttara East", "উত্তরা পূর্ব"],
  ["uttara-west", "Uttara West", "উত্তরা পশ্চিম"],
  ["uttarkhan", "Uttarkhan", "উত্তরখান"],
  ["wari", "Wari", "ওয়ারী"],
];

const dhakaUpazilas: [string, string, string, string][] = [
  ["savar", "Savar", "সাভার", "dhaka_suburb"],
  ["keraniganj", "Keraniganj", "কেরানীগঞ্জ", "dhaka_suburb"],
  ["dhamrai", "Dhamrai", "ধামরাই", "outside_dhaka"],
  ["dohar", "Dohar", "দোহার", "outside_dhaka"],
  ["nawabganj", "Nawabganj", "নবাবগঞ্জ", "outside_dhaka"],
];

export function bdLocationSeeds(): LocationSeed[] {
  const rows: LocationSeed[] = [];
  for (const [code, nameEn, nameBn] of divisions)
    rows.push({
      code: `div-${code}`,
      level: "division",
      parentCode: null,
      nameEn,
      nameBn,
      zoneCode: null,
    });
  for (const [division, list] of Object.entries(districts))
    for (const [code, nameEn, nameBn] of list)
      rows.push({
        code: `dist-${code}`,
        level: "district",
        parentCode: `div-${division}`,
        nameEn,
        nameBn,
        zoneCode:
          code === "dhaka"
            ? "inside_dhaka"
            : suburbDistricts.has(code)
              ? "dhaka_suburb"
              : "outside_dhaka",
      });
  for (const [code, nameEn, nameBn] of dhakaCityThanas)
    rows.push({
      code: `thana-dhaka-${code}`,
      level: "thana",
      parentCode: "dist-dhaka",
      nameEn,
      nameBn,
      zoneCode: "inside_dhaka",
    });
  for (const [code, nameEn, nameBn, zoneCode] of dhakaUpazilas)
    rows.push({
      code: `thana-dhaka-${code}`,
      level: "thana",
      parentCode: "dist-dhaka",
      nameEn,
      nameBn,
      zoneCode,
    });
  return rows;
}
