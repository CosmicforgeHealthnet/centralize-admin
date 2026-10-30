"use client";

"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Smile, Paperclip, Send, Loader2, X } from "lucide-react";
import { useProfileStore } from "@/stores/profile.store";
import ProfileSubNav from "./ProfileSubNav";
import ProfileCard from "./profile-info/ProfileCard";
import PersonalInfoTab from "./profile-info/PersonalInfoTab";
import EmploymentDetailsTab from "./profile-info/EmploymentDetailsTab";
import DocumentsTab from "./profile-info/DocumentsTab";
import ReportsTab, { Report } from "./profile-info/ReportsTab";
import PerformanceTab from "./profile-info/PerformanceTab";
import ProjectsPage from "./projects/ProjectsPage";
import ProjectsList from "./projects/ProjectsList";
import ProjectDetail from "./projects/ProjectDetail";
import TasksList from "./tasks/TasksList";
import TaskDetail from "./tasks/TaskDetail";
import TeamsList from "./teams/TeamsList";
import ActivityLogs from "./activity-logs/ActivityLogs";
import NotificationTab from "./notification/NotificationTab";
import EmojiPicker from "emoji-picker-react";
import type { ProjectItem } from "@/types/profile.types";

const profileTabs = [
  "Personal Info",
  "Employment Details",
  "Documents",
  "Reports",
  "Performance",
];

interface ReportDetailProps {
  report: Report;
  onBack: () => void;
}

function ReportDetail({ report, onBack }: ReportDetailProps) {
  const { addReport, updateReport, isUpdatingReports, error } = useProfileStore();
  const isNew = report.id === "new";
  const isEditing = !isNew;

  const [title, setTitle] = useState(report.title || "");
  const [body, setBody] = useState(report.body || "");
  const [note, setNote] = useState(report.note || "");
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const noteInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const showToast = (type: "success" | "error", message: string) => {
    setToast({ type, message });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!allowedTypes.includes(file.type)) {
      setFileError("Only PDF and DOCX files are allowed.");
      setAttachedFile(null);
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setFileError("File size must be under 10MB.");
      setAttachedFile(null);
      return;
    }
    setFileError(null);
    setAttachedFile(file);
  };

  const handleRemoveFile = () => {
    setAttachedFile(null);
    setFileError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleEmojiClick = (emojiData: { emoji: string }) => {
    const emoji = emojiData.emoji;
    const input = noteInputRef.current;
    if (!input) {
      setNote((prev) => prev + emoji);
      return;
    }
    const start = input.selectionStart ?? note.length;
    const end = input.selectionEnd ?? note.length;
    const newNote = note.slice(0, start) + emoji + note.slice(end);
    setNote(newNote);
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(start + emoji.length, start + emoji.length);
    }, 0);
    setShowEmojiPicker(false);
  };

  const handleSave = async () => {
    if (!title.trim()) {
      showToast("error", "Please enter a report title.");
      return;
    }
    try {
      if (isNew) {
        await addReport({
          ...(attachedFile ? { file: attachedFile } : {}),
          title: title.trim(),
          body: body.trim() || null,
          note: note.trim() || null,
        });
      } else {
        await updateReport(report.id, {
          ...(attachedFile ? { file: attachedFile } : {}),
          title: title.trim(),
          body: body.trim() || null,
          note: note.trim() || null,
        });
      }
      showToast("success", isNew ? "Report created successfully." : "Report updated successfully.");
      setTimeout(() => onBack(), 1200);
    } catch {
      showToast("error", error || "Something went wrong. Please try again.");
    }
  };

  const hasExistingFile = !isNew && report.url;
  const hasSelectedFile = attachedFile !== null;

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6 md:p-8 relative">

      {toast && (
        <div
          className={`fixed top-5 right-5 z-[100] px-4 py-3 rounded-[10px] shadow-lg text-[13px] font-poppins text-white transition-all ${
            toast.type === "success" ? "bg-green-500" : "bg-destructive"
          }`}
        >
          {toast.message}
        </div>
      )}

      <button
        onClick={onBack}
        className="flex items-center gap-2 text-[13px] font-poppins text-foreground hover:opacity-70 transition-opacity w-fit"
      >
        <ArrowLeft size={16} />
        Go Back
      </button>

      <div>
        <h2 className="text-[22px] sm:text-[26px] font-poppins font-bold text-foreground leading-tight">
          {isNew ? "New Report" : "Edit Report"}
        </h2>
        <p className="text-[13px] font-poppins text-muted-foreground mt-1">
          {isNew
            ? "Add a title and body. Attaching a file is optional."
            : "Update the details below. Attaching a new file will replace the existing one."}
        </p>
      </div>

      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={handleFileChange}
          className="hidden"
        />

        {(hasExistingFile || hasSelectedFile) && (
          <div className="flex items-center justify-between border border-border rounded-[12px] px-4 py-3 mb-2">
            <div className="flex items-center gap-2">
              <Paperclip size={16} className="text-muted-foreground shrink-0" />
              <span className="text-[13px] font-poppins text-foreground truncate">
                {hasSelectedFile
                  ? attachedFile!.name
                  : `${report.title}.${report.type}`}
              </span>
            </div>
            <button
              onClick={handleRemoveFile}
              className="text-muted-foreground hover:text-destructive transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 border border-dashed border-border rounded-[12px] px-4 py-3 w-full text-left hover:border-primary transition-colors"
        >
          <Paperclip size={16} className="text-muted-foreground shrink-0" />
          <span className="text-[13px] font-poppins text-muted-foreground truncate">
            {hasExistingFile || hasSelectedFile
              ? "Click to replace or add another file"
              : "Attach a file (optional) - PDF or DOCX only"}
          </span>
        </button>
        {fileError && (
          <p className="text-[12px] font-poppins text-destructive mt-1.5">{fileError}</p>
        )}
      </div>

      <div className="border border-border rounded-[12px] px-4 sm:px-5 py-4">
        <p className="text-[12px] font-poppins font-semibold text-foreground mb-2">Title</p>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Enter report title..."
          className="w-full bg-transparent border-0 outline-none text-[13px] font-poppins text-foreground placeholder:text-muted-foreground"
        />
      </div>

      <div className="border border-border rounded-[12px] px-4 sm:px-5 py-4">
        <p className="text-[12px] font-poppins font-semibold text-foreground mb-3">Body</p>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write your report here..."
          rows={8}
          className="w-full bg-transparent border-0 outline-none text-[13px] font-poppins text-foreground resize-none leading-relaxed placeholder:text-muted-foreground"
        />
      </div>

      <div className="relative">
        {showEmojiPicker && (
          <div ref={emojiPickerRef} className="absolute bottom-14 left-0 z-50">
            <EmojiPicker onEmojiClick={handleEmojiClick} skinTonesDisabled searchDisabled height={350} />
          </div>
        )}

        <div className="flex items-center gap-2 border border-border rounded-full px-4 py-3">
          <button
            type="button"
            onClick={() => setShowEmojiPicker((v) => !v)}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <Smile size={20} />
          </button>
          <input
            ref={noteInputRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note..."
            className="flex-1 bg-transparent border-0 outline-none text-[13px] font-poppins text-foreground placeholder:text-muted-foreground min-w-0"
          />
          <button
            onClick={handleSave}
            disabled={isUpdatingReports || !title.trim()}
            className="bg-primary text-white rounded-full w-9 h-9 flex items-center justify-center hover:opacity-90 transition-opacity shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isUpdatingReports ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4 sm:p-5 sm:flex-row sm:items-start animate-pulse">
      <div className="flex flex-col gap-3 w-full sm:w-[200px] shrink-0">
        <div className="w-full sm:w-[189px] h-[214px] bg-muted rounded-[10px]" />
        <div className="w-full sm:w-[200px] h-[300px] bg-muted rounded-[10px]" />
      </div>
      <div className="flex-1 flex flex-col gap-4">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-12 bg-muted rounded-[10px]" />
        ))}
      </div>
    </div>
  );
}

function ProfilePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSubNav = searchParams.get("tab") ?? "Profile Info";

  const [activeTab, setActiveTab] = useState("Personal Info");
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [selectedTask, setSelectedTask] = useState<{ id: string } | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectItem | null>(null);

  const { fetchProfile, isLoading, profile } = useProfileStore();

  useEffect(() => {
    if (!profile) fetchProfile();
  }, [fetchProfile, profile]);

  const handleSubNavClick = (item: string) => {
    setSelectedTask(null);
    setSelectedReport(null);
    setSelectedProject(null);
    router.push(`/dashboard/profile?tab=${encodeURIComponent(item)}`);
  };

  const tabCardRef = useRef<HTMLDivElement>(null);
  const isFirstTabClick = useRef(true);

  const handleTabClick = (tab: string) => {
    setActiveTab(tab);

    if (isFirstTabClick.current) {
      isFirstTabClick.current = false;
      return;
    }

    if (window.innerWidth < 640) {
      setTimeout(() => {
        tabCardRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 10);
    }
  };

  const renderContent = () => {
    // For all sub-pages, show the ProfileSubNav on the left
    return (
      <div className="flex flex-col gap-4 min-[1014px]:flex-row min-[1014px]:items-start">
        <ProfileSubNav activeItem={activeSubNav} onItemClick={handleSubNavClick} />

        <div
          ref={tabCardRef}
          className="flex-1 min-w-0 bg-card border border-border rounded-[12px] overflow-hidden"
        >
          {/* Projects Page */}
          {activeSubNav === "Projects" && (
            selectedProject ? (
              <ProjectDetail
                projectId={selectedProject.id}
                onBack={() => setSelectedProject(null)}
              />
            ) : (
              <ProjectsList onSelectProject={setSelectedProject} />
            )
          )}

          {/* Tasks Page */}
          {activeSubNav === "Tasks" && (
            selectedTask ? (
              <TaskDetail taskId={selectedTask.id} onBack={() => setSelectedTask(null)} />
            ) : (
              <TasksList onSelectTask={setSelectedTask} />
            )
          )}

          {/* Teams Page */}
          {activeSubNav === "Teams" && <TeamsList />}

          {/* Activity Logs Page */}
          {activeSubNav === "Activity Logs" && <ActivityLogs />}

          {/* Notification Page */}
          {activeSubNav === "Notification" && <NotificationTab />}

          {/* Default - Profile Info with tabs */}
          {activeSubNav === "Profile Info" && (
            <>
              {selectedReport ? (
                <ReportDetail
                  report={selectedReport}
                  onBack={() => setSelectedReport(null)}
                />
              ) : (
                <>
                  <div className="px-4 sm:px-5 pt-4 sm:pt-5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-[15px] font-poppins font-semibold text-foreground">
                        Employee Profile
                      </span>
                      <div className="flex items-center overflow-x-auto -mb-px scrollbar-none">
                        {profileTabs.map((tab) => (
                          <button
                            key={tab}
                            onClick={() => handleTabClick(tab)}
                            className={`px-3 pb-1 text-[13px] font-poppins whitespace-nowrap border-b-2 transition-colors ${
                              activeTab === tab
                                ? "border-primary text-primary"
                                : "border-transparent text-muted-foreground"
                            }`}
                          >
                            {tab}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="border-b border-border" />
                  </div>

                  {isLoading && !profile ? (
                    <ProfileSkeleton />
                  ) : (
                    <div className="flex flex-col gap-4 p-4 sm:p-5 sm:flex-row sm:items-start">
                      <ProfileCard />
                      <div className="flex-1 min-w-0">
                        {activeTab === "Personal Info" && <PersonalInfoTab />}
                        {activeTab === "Employment Details" && <EmploymentDetailsTab />}
                        {activeTab === "Documents" && <DocumentsTab />}
                        {activeTab === "Reports" && (
                          <ReportsTab onSelectReport={setSelectedReport} />
                        )}
                        {activeTab === "Performance" && <PerformanceTab />}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return renderContent();
}

export default function ProfilePage() {
  return (
    <Suspense fallback={null}>
      <ProfilePageInner />
    </Suspense>
  );
}