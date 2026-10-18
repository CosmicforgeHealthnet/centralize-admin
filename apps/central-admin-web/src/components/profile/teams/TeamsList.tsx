"use client";

import React, { useEffect } from "react";
import Image from "next/image";
import { useProfileStore } from "@/stores/profile.store";

const avatarImages = ["/profile-img.png", "/profile-picture.png"];

export default function TeamsList() {
  const {
    teams,
    fetchMyTeams,
    isLoadingTeams,
  } = useProfileStore();

  useEffect(() => {
    fetchMyTeams();
  }, [fetchMyTeams]);

  return (
    <div className="flex flex-col gap-4 p-6 sm:p-8">
      <div>
        <h1 className="text-[24px] font-poppins font-bold text-foreground">
          Teams
        </h1>

        <p className="text-[13px] font-poppins text-muted-foreground mt-1">
          Here you have a list of Teams you are part of.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr style={{ backgroundColor: "#E8EAF6" }}>
              <th className="px-4 py-3 text-[12px] font-poppins font-semibold text-foreground rounded-l-[8px]">
                Team Title
              </th>

              <th className="px-4 py-3 rounded-r-[8px]" />
            </tr>
          </thead>

          <tbody>
            {isLoadingTeams ? (
              <tr>
                <td
                  colSpan={2}
                  className="px-4 py-6 text-center text-sm text-muted-foreground"
                >
                  Loading teams...
                </td>
              </tr>
            ) : teams.length === 0 ? (
              <tr>
                <td
                  colSpan={2}
                  className="px-4 py-6 text-center text-sm text-muted-foreground"
                >
                  No teams found
                </td>
              </tr>
            ) : (
              teams.map((team) => (
                <tr
                  key={team.id}
                  className="border-b border-border last:border-0"
                >
                <td className="px-4 py-4 text-[13px] font-poppins text-foreground">
  {team.title}
</td>

                  <td className="px-4 py-4">
                    <div className="flex items-center justify-end">
                      <div className="flex -space-x-2">
                        {(team.members || []).map((member, i) => (
                          <div
                            key={member.id}
                            className="w-8 h-8 rounded-full border-2 border-white overflow-hidden shrink-0"
                          >
                            <Image
                              src={
                                member.avatarUrl ||
                                avatarImages[i % avatarImages.length]
                              }
                              alt={member.name}
                              width={32}
                              height={32}
                              className="w-full h-full object-cover"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}