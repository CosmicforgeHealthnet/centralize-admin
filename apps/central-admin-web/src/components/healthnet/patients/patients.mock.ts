export type ProfileType = "Individual" | "Family";

export interface Patient {
  id: string;
  name: string;
  profileType: ProfileType;
  email: string;
  phone: string;
  joiningDate: string;
  avatar?: string;
  sex: string;
  age: number;
  bloodGroup: string;
  genotype: string;
  height: string;
  weight: string;
  allergies: string;
  homeAddress: string;
  workAddress: string;
  location: string;
}

export interface Appointment {
  id: string;
  doctorName: string;
  specialty: string;
  date: string;
  time: string;
  index: number;
  total: number;
  status: "upcoming" | "past" | "cancelled";
  slotIndex: number; // which TIME_SLOTS index this belongs to
}

export const MOCK_PATIENTS: Patient[] = Array.from({ length: 40 }, (_, i) => {
  const types: ProfileType[] = ["Family", "Individual"];
  const names = [
    "Jennifer Grace", "Grace Williams", "Amaka Johnson", "Chisom Obi",
    "Fatima Bello", "Ngozi Eze", "Blessing Adeyemi", "Chiamaka Nwosu",
    "Aisha Mohammed", "Oluwaseun Adebayo",
  ];
  const name = names[i % names.length];
  const type = types[i % 2];
  return {
    id: `patient-${i + 1}`,
    name,
    profileType: type,
    email: `${name.toLowerCase().replace(" ", "")}@gmail.com`,
    phone: "+234 9034 456 3456",
    joiningDate: "08/06/2024",
    sex: i % 3 === 0 ? "Male" : "Female",
    age: 20 + (i % 40),
    bloodGroup: ["O+", "A+", "B+", "AB+"][i % 4],
    genotype: ["AS", "AA", "SS"][i % 3],
    height: `${155 + (i % 25)} cm`,
    weight: `${50 + (i % 40)} kg`,
    allergies: i % 5 === 0 ? "Penicillin" : "Nil",
    homeAddress: "6th Av, Lekki Lagos.",
    workAddress: "Joana Cr Lekki Lagos.",
    location: "Lagos, Nigeria.",
  };
});

MOCK_PATIENTS[0] = {
  ...MOCK_PATIENTS[0],
  name: "Mrs Grace Williams",
  email: "gracewilliams@gmail.com",
  profileType: "Family",
  sex: "Female",
  age: 26,
  bloodGroup: "O+",
  genotype: "AS",
  height: "160 cm",
  weight: "59 kg",
  allergies: "Nil",
  homeAddress: "6th Av, Lekki Lagos.",
  workAddress: "Joana Cr Lekki Lagos.",
  location: "Lagos, Nigeria.",
};

// slotIndex maps to TIME_SLOTS: 0=07:00 1=08:00 2=09:00 3=10:00 4=11:00 5=12:00 6=01:00 7=02:00 8=03:00 9=04:00 10=05:00 11=06:00 12=07:00
// Spread realistically across the day with gaps — matching Figma
export const MOCK_APPOINTMENTS: Appointment[] = [
  { id: "u1", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "07:00 - 08:00 am", index: 1, total: 6, status: "upcoming", slotIndex: 0 },
  { id: "u2", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "08:00 - 09:00 am", index: 2, total: 6, status: "upcoming", slotIndex: 1 },
  { id: "u3", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "10:00 - 11:00 am", index: 3, total: 6, status: "upcoming", slotIndex: 3 },
  { id: "u4", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "12:00 - 01:00 pm", index: 4, total: 6, status: "upcoming", slotIndex: 5 },
  { id: "u5", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "03:00 - 04:00 pm", index: 5, total: 6, status: "upcoming", slotIndex: 8 },
  { id: "u6", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "05:00 - 06:00 pm", index: 6, total: 6, status: "upcoming", slotIndex: 10 },
];

export const MOCK_PAST_APPOINTMENTS: Appointment[] = [
  { id: "p1", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "07:00 - 08:00 am", index: 1, total: 50, status: "past", slotIndex: 0 },
  { id: "p2", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "09:00 - 10:00 am", index: 2, total: 50, status: "past", slotIndex: 2 },
  { id: "p3", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "11:00 - 12:00 pm", index: 3, total: 50, status: "past", slotIndex: 4 },
  { id: "p4", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "12:00 - 01:00 pm", index: 4, total: 50, status: "past", slotIndex: 5 },
  { id: "p5", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "04:00 - 05:00 pm", index: 5, total: 50, status: "past", slotIndex: 9 },
  { id: "p6", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "06:00 - 07:00 pm", index: 6, total: 50, status: "past", slotIndex: 11 },
];

export const MOCK_CANCELLED_APPOINTMENTS: Appointment[] = [
  { id: "c1", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "08:00 - 09:00 am", index: 1, total: 4, status: "cancelled", slotIndex: 1 },
  { id: "c2", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "10:00 - 11:00 am", index: 2, total: 4, status: "cancelled", slotIndex: 3 },
  { id: "c3", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "02:00 - 03:00 pm", index: 3, total: 4, status: "cancelled", slotIndex: 7 },
  { id: "c4", doctorName: "Dr Josh Olawale", specialty: "Obstetrics & gynecology", date: "7th January 2025", time: "05:00 - 06:00 pm", index: 4, total: 4, status: "cancelled", slotIndex: 10 },
];