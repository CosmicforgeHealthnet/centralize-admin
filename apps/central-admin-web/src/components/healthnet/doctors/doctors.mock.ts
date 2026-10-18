export interface Doctor {
  id: string;
  name: string;
  department: string;
  degree: string;
  email: string;
  phone: string;
  joiningDate: string;
  avatar?: string;
  hospital: string;
  location: string;
  address: string;
  rating: number;
  patients: string;
  experience: string;
  bio: string;
  workingDays: string;
  workingHours: string;
}

export interface DoctorAppointment {
  id: string;
  patientName: string;
  specialty: string;
  date: string;
  time: string;
  index: number;
  total: number;
  status: "upcoming" | "past" | "cancelled";
  slotIndex: number;
}

export interface DoctorCertification {
  id: string;
  title: string;
  licenseNumber: string;
  expiryDate: string;
  imageUrl?: string;
  index: number;
}

export interface DoctorRating {
  id: string;
  reviewerName: string;
  stars: number;
  comment: string;
  timeAgo: string;
  avatar?: string;
}

export const MOCK_DOCTORS: Doctor[] = Array.from({ length: 40 }, (_, i) => {
  const departments = [
    "General Medicine",
    "Obstetrics & Gynecology",
    "Pediatrics",
    "Cardiology",
    "Neurology",
    "Orthopedics",
  ];
  const names = [
    "Dr Josh Olawale",
    "Dr Amaka Obi",
    "Dr Fatima Bello",
    "Dr Chukwuemeka Eze",
    "Dr Sarah Adeyemi",
    "Dr Michael Nwosu",
    "Dr Ngozi Mohammed",
    "Dr Tunde Adebayo",
    "Dr Grace Johnson",
    "Dr Samuel Williams",
  ];
  const name = names[i % names.length];
  const dept = departments[i % departments.length];
  return {
    id: `doctor-${i + 1}`,
    name,
    department: dept,
    degree: i % 3 === 0 ? "MBBS, MS" : i % 3 === 1 ? "MBBS, MD" : "MBBS, FRCOG",
    email: `${name.toLowerCase().replace(/\s+/g, "").replace("dr", "")}@healthnet.com`,
    phone: "+234 9034 456 3456",
    joiningDate: "08/06/2024",
    hospital: "Chastain Park Hospital, Lekki, Lagos, Nigeria.",
    location: "Lagos, Nigeria.",
    address: "Chastain Park Hospital, Lekki, Lagos, Nigeria.",
    rating: parseFloat((4.0 + (i % 10) * 0.1).toFixed(1)),
    patients: `${1000 + i * 50}+`,
    experience: `${2 + (i % 10)} years+`,
    bio: `${name} is a dedicated and compassionate ${dept} doctor with over ${2 + (i % 10)} years of experience in providing exceptional care. Known for their patient-centered approach, they hold an impressive ${(4.0 + (i % 10) * 0.1).toFixed(1)}-star rating and have successfully attended to more than ${1000 + i * 50} patients. They are committed to delivering comprehensive medical solutions, empowering their patients to achieve optimal health and well-being.`,
    workingDays: "Monday - Saturday",
    workingHours: "07:00am - 06:00pm",
  };
});

// Override first doctor to match Figma exactly
MOCK_DOCTORS[0] = {
  ...MOCK_DOCTORS[0],
  name: "Dr Josh Olawale",
  department: "General Medicine",
  degree: "MBBS, MS",
  email: "gracewilliams@gmail.com",
  phone: "+234 9034 456 3456",
  hospital: "Chastain Park Hospital, Lekki, Lagos, Nigeria.",
  location: "Lagos, Nigeria.",
  address: "Chastain Park Hospital, Lekki, Lagos, Nigeria.",
  rating: 4.7,
  patients: "1500+",
  experience: "3 years+",
  bio: "Dr. Josh Olawale is a dedicated and compassionate General Medicine doctor with over 3 years of experience in providing exceptional care. Known for his patient-centered approach, he holds an impressive 4.7-star rating and has successfully attended to more than 1,500 patients. Dr. Olawale is committed to delivering comprehensive medical solutions, empowering his patients to achieve optimal health and well-being.",
  workingDays: "Monday - Saturday",
  workingHours: "07:00am - 06:00pm",
};

// TIME_SLOTS: 0=07:00 1=08:00 2=09:00 3=10:00 4=11:00 5=12:00 6=01:00 7=02:00 8=03:00 9=04:00 10=05:00 11=06:00 12=07:00
export const MOCK_DOCTOR_UPCOMING: DoctorAppointment[] = [
  { id: "du1", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "07:00 - 08:00 am", index: 1, total: 6, status: "upcoming", slotIndex: 0 },
  { id: "du2", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "08:00 - 09:00 am", index: 2, total: 6, status: "upcoming", slotIndex: 1 },
  { id: "du3", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "10:00 - 11:00 am", index: 3, total: 6, status: "upcoming", slotIndex: 3 },
  { id: "du4", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "12:00 - 01:00 pm", index: 4, total: 6, status: "upcoming", slotIndex: 5 },
  { id: "du5", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "03:00 - 04:00 pm", index: 5, total: 6, status: "upcoming", slotIndex: 8 },
  { id: "du6", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "05:00 - 06:00 pm", index: 6, total: 6, status: "upcoming", slotIndex: 10 },
];

export const MOCK_DOCTOR_PAST: DoctorAppointment[] = [
  { id: "dp1", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "07:00 - 08:00 am", index: 1, total: 50, status: "past", slotIndex: 0 },
  { id: "dp2", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "09:00 - 10:00 am", index: 2, total: 50, status: "past", slotIndex: 2 },
  { id: "dp3", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "11:00 - 12:00 pm", index: 3, total: 50, status: "past", slotIndex: 4 },
  { id: "dp4", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "12:00 - 01:00 pm", index: 4, total: 50, status: "past", slotIndex: 5 },
  { id: "dp5", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "04:00 - 05:00 pm", index: 5, total: 50, status: "past", slotIndex: 9 },
  { id: "dp6", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "06:00 - 07:00 pm", index: 6, total: 50, status: "past", slotIndex: 11 },
];

export const MOCK_DOCTOR_CANCELLED: DoctorAppointment[] = [
  { id: "dc1", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "08:00 - 09:00 am", index: 1, total: 4, status: "cancelled", slotIndex: 1 },
  { id: "dc2", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "10:00 - 11:00 am", index: 2, total: 4, status: "cancelled", slotIndex: 3 },
  { id: "dc3", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "02:00 - 03:00 pm", index: 3, total: 4, status: "cancelled", slotIndex: 7 },
  { id: "dc4", patientName: "Jennifer Williams", specialty: "General Consultation", date: "7th January 2025", time: "05:00 - 06:00 pm", index: 4, total: 4, status: "cancelled", slotIndex: 10 },
];

export const MOCK_DOCTOR_CERTIFICATIONS: DoctorCertification[] = [
  {
    id: "cert1",
    title: "MBBS",
    licenseNumber: "0000123678593",
    expiryDate: "31/01/2025",
    imageUrl: "/cert-harvard.png",
    index: 1,
  },
  {
    id: "cert2",
    title: "ACLS License",
    licenseNumber: "0000123678593",
    expiryDate: "31/01/2025",
    imageUrl: "/cert-dubai.png",
    index: 1,
  },
  {
    id: "cert3",
    title: "FRCOG",
    licenseNumber: "0000123678593",
    expiryDate: "31/01/2026",
    imageUrl: "/cert-harvard.png",
    index: 2,
  },
  {
    id: "cert4",
    title: "MD License",
    licenseNumber: "0000123678593",
    expiryDate: "31/01/2026",
    imageUrl: "/cert-dubai.png",
    index: 2,
  },
];

export const MOCK_DOCTOR_RATINGS: DoctorRating[] = [
  {
    id: "r1",
    reviewerName: "Janet Opeyemi",
    stars: 4,
    comment: "Dr. Josh Olawale was really integral to my treatment process. I'm grateful for him.",
    timeAgo: "3 sec ago",
    avatar: "/profile-img.png",
  },
  {
    id: "r2",
    reviewerName: "John Shadrach",
    stars: 4,
    comment: "He saved my daughter's life with smart diagnosis.",
    timeAgo: "5 hours ago",
    avatar: "/profile-img.png",
  },
  {
    id: "r3",
    reviewerName: "Amaka Johnson",
    stars: 5,
    comment: "Exceptional doctor. Very thorough and professional in his approach.",
    timeAgo: "1 day ago",
    avatar: "/profile-img.png",
  },
  {
    id: "r4",
    reviewerName: "Tunde Bello",
    stars: 4,
    comment: "Great experience overall. Would highly recommend.",
    timeAgo: "2 days ago",
    avatar: "/profile-img.png",
  },
];