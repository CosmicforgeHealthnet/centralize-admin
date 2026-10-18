"use client";

import { useState } from "react";
import HealthnetSubNav, { type HealthnetSection } from "./HealthnetSubNav";
import HealthnetStatCards from "./dashboard/HealthnetStatCards";
import DoctorsChart from "./dashboard/DoctorsChart";
import PatientsStatisticsChart from "./dashboard/PatientsStatisticsChart";
import HealthnetRevenueTracking from "./dashboard/HealthnetRevenueTracking";
import AppointmentsPage from "./appointments/AppointmentsPage";
import DoctorsPage from "@/components/healthnet/doctors/DoctorsPage";
import PatientsPage from "@/components/healthnet/patients/PatientsPage";
import DoctorProfileDetail from "@/components/healthnet/doctors/DoctorProfileDetail";
import PatientProfileDetail from "@/components/healthnet/patients/PatientProfileDetail";
import LabsPage from "@/components/healthnet/labs/LabsPage";
import LabProfileDetail from "@/components/healthnet/labs/LabProfileDetail";
import PharmacyPage from "@/components/healthnet/pharmacy/PharmacyPage";
import PharmacyProfileDetail from "@/components/healthnet/pharmacy/PharmacyProfileDetail";
import FinancePage from "@/components/healthnet/finance/FinancePage";
import AnalyticsPage from "@/components/healthnet/analytics/AnalyticsPage";
import VendorsPage from "@/components/healthnet/vendors/VendorsPage";
import VendorProfileDetail from "@/components/healthnet/vendors/VendorProfileDetail"; // Import this

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[320px] gap-3">
      <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center">
        <span className="text-xl">🏗️</span>
      </div>
      <div className="text-center">
        <p className="text-[15px] font-poppins font-semibold text-foreground">{label}</p>
        <p className="text-[13px] font-poppins text-muted-foreground mt-1">
          This section is coming soon
        </p>
      </div>
    </div>
  );
}

export default function HealthnetPage() {
  const [activeSection, setActiveSection] = useState<HealthnetSection>("dashboard");
  const [selectedDoctorId, setSelectedDoctorId] = useState<string | null>(null);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [selectedLabId, setSelectedLabId] = useState<string | null>(null);
  const [selectedPharmacyId, setSelectedPharmacyId] = useState<string | null>(null);
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null); // ADD THIS

  const handleSectionChange = (section: HealthnetSection) => {
    setSelectedDoctorId(null);
    setSelectedPatientId(null);
    setSelectedLabId(null);
    setSelectedPharmacyId(null);
    setSelectedVendorId(null); // ADD THIS
    setActiveSection(section);
  };

  const handleViewDoctor = (id: string) => {
    setSelectedDoctorId(id);
    setActiveSection("doctors");
  };

  const handleViewPatient = (id: string) => {
    setSelectedPatientId(id);
    setActiveSection("patients");
  };

  const handleViewLab = (id: string) => {
    setSelectedLabId(id);
    setActiveSection("labs");
  };

  const handleViewPharmacy = (id: string) => {
    setSelectedPharmacyId(id);
    setActiveSection("pharmacy");
  };

  const handleViewVendor = (id: string) => { // ADD THIS
    setSelectedVendorId(id);
    setActiveSection("vendors");
  };

  const handleBackToList = () => {
    setSelectedDoctorId(null);
    setSelectedPatientId(null);
    setSelectedLabId(null);
    setSelectedPharmacyId(null);
    setSelectedVendorId(null); // ADD THIS
  };

  return (
    <div className="flex gap-4">
      {/* Desktop subnav */}
      <div className="hidden min-[1014px]:block w-[160px] shrink-0">
        <HealthnetSubNav active={activeSection} onChange={handleSectionChange} />
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {/* Mobile subnav */}
        <div className="min-[1014px]:hidden">
          <HealthnetSubNav active={activeSection} onChange={handleSectionChange} />
        </div>

        {/* Dashboard */}
        {activeSection === "dashboard" && (
          <>
            <div>
              <h1 className="text-title text-foreground mb-1">Healthnet</h1>
              <p className="text-[13px] font-poppins text-muted-foreground">
                Manage and monitor your healthcare platform.
              </p>
            </div>
            <HealthnetStatCards />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <DoctorsChart />
              <PatientsStatisticsChart />
            </div>
            <HealthnetRevenueTracking />
          </>
        )}

        {/* Appointments */}
        {activeSection === "appointments" && <AppointmentsPage />}

        {/* Doctors */}
        {activeSection === "doctors" && (
          <div className="relative">
            {selectedDoctorId ? (
              <div>
                <button
                  onClick={handleBackToList}
                  className="mb-4 text-[13px] font-poppins text-[#272EA7] hover:underline flex items-center gap-1"
                >
                  ← Back to Doctors List
                </button>
                <DoctorProfileDetail
                  id={selectedDoctorId}
                  onBack={handleBackToList}
                />
              </div>
            ) : (
              <DoctorsPage onViewDoctor={handleViewDoctor} />
            )}
          </div>
        )}

        {/* Patients */}
        {activeSection === "patients" && (
          <div className="relative">
            {selectedPatientId ? (
              <div>
                <button
                  onClick={handleBackToList}
                  className="mb-4 text-[13px] font-poppins text-[#272EA7] hover:underline flex items-center gap-1"
                >
                  ← Back to Patients List
                </button>
                <PatientProfileDetail
                  id={selectedPatientId}
                  onBack={handleBackToList}
                />
              </div>
            ) : (
              <PatientsPage onViewPatient={handleViewPatient} />
            )}
          </div>
        )}
         
        {/* Vendors - FIXED */}
        {activeSection === "vendors" && (
          <div className="relative">
            {selectedVendorId ? (
              <div>
                <button
                  onClick={handleBackToList}
                  className="mb-4 text-[13px] font-poppins text-[#272EA7] hover:underline flex items-center gap-1"
                >
                  ← Back to Vendors List
                </button>
                <VendorProfileDetail
                  id={selectedVendorId}
                  onBack={handleBackToList}
                />
              </div>
            ) : (
              <VendorsPage onViewVendor={handleViewVendor} />
            )}
          </div>
        )}

        {/* Labs */}
        {activeSection === "labs" && (
          <div className="relative">
            {selectedLabId ? (
              <div>
                <button
                  onClick={handleBackToList}
                  className="mb-4 text-[13px] font-poppins text-[#272EA7] hover:underline flex items-center gap-1"
                >
                  ← Back to Labs List
                </button>
                <LabProfileDetail id={selectedLabId} onBack={handleBackToList} />
              </div>
            ) : (
              <LabsPage onViewLab={handleViewLab} />
            )}
          </div>
        )}

        {/* Pharmacy */}
        {activeSection === "pharmacy" && (
          <div className="relative">
            {selectedPharmacyId ? (
              <div>
                <button
                  onClick={handleBackToList}
                  className="mb-4 text-[13px] font-poppins text-[#272EA7] hover:underline flex items-center gap-1"
                >
                  ← Back to Pharmacy List
                </button>
                <PharmacyProfileDetail
                  id={selectedPharmacyId}
                  onBack={handleBackToList}
                />
              </div>
            ) : (
              <PharmacyPage onViewPharmacy={handleViewPharmacy} />
            )}
          </div>
        )}

        {activeSection === "finance" && <FinancePage />}
        {activeSection === "analytics" && <AnalyticsPage />}
        

        {/* Coming Soon for remaining sections */}
        {activeSection !== "dashboard" &&
          activeSection !== "appointments" &&
          activeSection !== "doctors" &&
          activeSection !== "patients" &&
          activeSection !== "labs" &&
          activeSection !== "vendors" &&
          activeSection !== "finance" &&
          activeSection !== "analytics" &&
          activeSection !== "pharmacy" && (
            <ComingSoon
              label={activeSection.charAt(0).toUpperCase() + activeSection.slice(1)}
            />
          )}
      </div>
    </div>
  );
}