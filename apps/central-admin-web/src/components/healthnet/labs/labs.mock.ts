export interface Lab {
  id: string;
  name: string;
  location: string;
  email: string;
  phone: string;
  joiningDate: string;
  avatar?: string;
  // Detail fields
  businessName: string;
  registrationNumber: string;
  businessAddress: string;
  labWebsite: string;
  operationHours: string;
  contactFullName: string;
  contactPhone: string;
  contactEmail: string;
  contactLocation: string;
  registrationDate: string;
  status: "pending" | "approved" | "rejected";
  noOfStaffs: string;
}

export interface LabStaff {
  id: string;
  name: string;
  experience: string;
  phone: string;
  avatar?: string;
  role: LabStaffRole;
}

export type LabStaffRole =
  | "Phlebotomists"
  | "Sample Collector"
  | "Radiologists"
  | "Result Entry"
  | "Result Reviewer";

export interface LabDocument {
  id: string;
  title: string;
  fileSize: string;
  imageUrl?: string;
}

const STAFF_NAMES = [
  "Karen Williams",
  "John Obi",
  "Fatima Bello",
  "Samuel Eze",
  "Grace Johnson",
];

function makeStaff(role: LabStaffRole, count = 5): LabStaff[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${role}-${i}`,
    name: STAFF_NAMES[i % STAFF_NAMES.length],
    experience: "2 years experience",
    phone: "+2348067735987",
    role,
    avatar: "/profile-img.png",
  }));
}

export const MOCK_LAB_STAFF: LabStaff[] = [
  ...makeStaff("Phlebotomists"),
  ...makeStaff("Sample Collector"),
  ...makeStaff("Radiologists"),
  ...makeStaff("Result Entry"),
  ...makeStaff("Result Reviewer"),
];

export const MOCK_LAB_DOCUMENTS: LabDocument[] = [
  {
    id: "doc1",
    title: "Government Approved I.D",
    fileSize: "4MB",
    imageUrl: "/profile-picture.png",
  },
  {
    id: "doc2",
    title: "Registration Document",
    fileSize: "4MB",
    imageUrl: "/profile-picture.png",
  },
  {
    id: "doc3",
    title: "License",
    fileSize: "4MB",
    imageUrl: "/profile-picture.png",
  },
];

export const MOCK_LABS: Lab[] = Array.from({ length: 40 }, (_, i) => ({
  id: `lab-${i + 1}`,
  name: i === 0 ? "Zion Diagnostics" : `${["Apex", "Prime", "Elite", "Nova", "Zion", "Crest", "Peak", "Vital", "Core", "Unity"][i % 10]} Diagnostics`,
  location: "Alimosho, Lagos Nigeria.",
  email: "gracewilliams@gmail.com",
  phone: "+234 9034 456 3456",
  joiningDate: "08/06/2024",
  avatar: "/profile-img.png",
  businessName: "Bellarie Lab",
  registrationNumber: "Bellarie123478",
  businessAddress: "12, Jakande Estate, Ikeja Lagos Nigeria.",
  labWebsite: "Loremipsum.com",
  operationHours: "Moday -Friday 07:00 AM – 07:00PM",
  contactFullName: "Dema UI/UX",
  contactPhone: "+23481234 567",
  contactEmail: "loremipsum@gmail.com",
  contactLocation: "Lagos, Nigeria",
  registrationDate: "Lagos, Nigeria",
  status: "pending",
  noOfStaffs: "1-50",
}));