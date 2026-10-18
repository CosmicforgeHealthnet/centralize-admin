"use client";

import React, { useEffect, useState } from "react";
import { useAuthStore } from "@/stores/auth.store";
import { useAuditStore } from "@/stores/audit.store";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

function getActionColor(action: string): string {
  const successActions = ["LOGIN", "LOGOUT", "PASSWORD_CHANGED", "PROFILE_UPDATED", "AVATAR_UPDATED"];
  const dangerActions = ["LOGIN_FAILED", "ACCOUNT_LOCKED", "USER_DELETED", "USER_DEACTIVATED"];
  const warningActions = ["USER_CREATED", "USER_UPDATED", "TICKET_ASSIGNED", "TICKET_UPDATED"];
  
  if (successActions.includes(action)) return "text-green-600";
  if (dangerActions.includes(action)) return "text-red-600";
  if (warningActions.includes(action)) return "text-yellow-600";
  return "text-muted-foreground";
}

function getActionDisplay(action: string): string {
  const displayMap: Record<string, string> = {
    "LOGIN": "logged in",
    "LOGOUT": "logged out",
    "LOGIN_FAILED": "failed login attempt",
    "ACCOUNT_LOCKED": "account locked",
    "PASSWORD_CHANGED": "changed password",
    "PASSWORD_RESET_REQUESTED": "requested password reset",
    "PASSWORD_RESET_COMPLETED": "completed password reset",
    "USER_CREATED": "created user",
    "USER_UPDATED": "updated user",
    "USER_DEACTIVATED": "deactivated user",
    "USER_ACTIVATED": "activated user",
    "USER_DELETED": "deleted user",
    "TICKET_RESOLVED": "resolved ticket",
    "TICKET_ASSIGNED": "assigned ticket",
    "TICKET_UPDATED": "updated ticket",
    "PAYMENT_VIEWED": "viewed payment",
    "APPOINTMENT_VIEWED": "viewed appointment",
    "TOKEN_REFRESHED": "refreshed token",
    "PROFILE_UPDATED": "updated profile",
    "DOCUMENT_UPLOADED": "uploaded document",
    "DOCUMENT_DELETED": "deleted document",
    "AVATAR_UPDATED": "updated avatar",
  };
  return displayMap[action] || action.toLowerCase();
}

export default function ActivityLogs() {
  const { user } = useAuthStore();
  const { groupedLogs, pagination, isLoading, fetchMyLogs, fetchAllLogs } = useAuditStore();
  const [currentPage, setCurrentPage] = useState(1);
  const [viewAll, setViewAll] = useState(false);
  const isAdmin = user?.tier === "SUPER" || user?.tier === "EXECUTIVE";

  useEffect(() => {
    if (viewAll && isAdmin) {
      fetchAllLogs(currentPage);
    } else {
      fetchMyLogs(currentPage);
    }
  }, [currentPage, viewAll, isAdmin]);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && pagination && newPage <= pagination.totalPages) {
      setCurrentPage(newPage);
    }
  };

  if (isLoading && groupedLogs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground mt-2">Loading activity logs...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-6 sm:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-2 gap-4">
        <div>
          <h1 className="text-[24px] font-poppins font-bold text-foreground">Activity Logs</h1>
          <p className="text-[13px] font-poppins text-muted-foreground mt-1">
            Track all your activities and actions across the platform
          </p>
        </div>
        
        {isAdmin && (
          <div className="flex gap-2">
            <Button
              variant={!viewAll ? "default" : "outline"}
               size="small"
              onClick={() => {
                setViewAll(false);
                setCurrentPage(1);
              }}
            >
              My Logs
            </Button>
            <Button
              variant={viewAll ? "default" : "outline"}
              size="small"
              onClick={() => {
                setViewAll(true);
                setCurrentPage(1);
              }}
            >
              All Logs
            </Button>
          </div>
        )}
      </div>

      {groupedLogs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4">
            <span className="text-2xl">📋</span>
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">No activity logs yet</h3>
          <p className="text-sm text-muted-foreground">
            Your activities will appear here once you start using the platform.
          </p>
        </div>
      ) : (
        <>
          {groupedLogs.map((group) => (
            <div key={group.date} className="flex flex-col">
              {group.date !== "Today" && (
                <div className="flex items-center justify-center py-4">
                  <span className="text-[12px] font-poppins text-muted-foreground bg-muted px-3 py-1 rounded-full">
                    {group.date}
                  </span>
                </div>
              )}

              {group.logs.map((log) => (
                <div key={log.id} className="flex items-start gap-3 py-3 border-b border-border last:border-0">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                    style={{ backgroundColor: "#E8EAF6" }}
                  >
                    <span className="text-[13px] font-poppins font-semibold text-primary">
                      {log.userName.charAt(0).toUpperCase()}
                    </span>
                  </div>

                  <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[13px] font-poppins font-semibold text-foreground">
                        {log.userName}
                      </span>
                      <span className="text-[12px] font-poppins text-muted-foreground">
                        · {log.time}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[13px] font-poppins ${getActionColor(log.action)}`}>
                        {getActionDisplay(log.action)}
                      </span>
                      {log.ipAddress && (
                        <span className="text-[11px] font-poppins text-muted-foreground">
                          from {log.ipAddress}
                        </span>
                      )}
                    </div>
                    {log.metadata && Object.keys(log.metadata).length > 0 && (
                      <p className="text-[11px] font-poppins text-muted-foreground mt-1">
                        {JSON.stringify(log.metadata).slice(0, 100)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}

          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6 pt-4 border-t border-border">
              <Button
                variant="outline"
                size="small"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1}
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </Button>
              <span className="text-[13px] font-poppins text-muted-foreground">
                Page {currentPage} of {pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="small"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage === pagination.totalPages}
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}