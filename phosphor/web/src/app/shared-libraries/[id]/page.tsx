"use client";
import { useParams } from "next/navigation";
import SharedLibraries from "@/components/SharedLibraries";
export default function SharedLibraryPage() { const { id } = useParams<{ id: string }>(); return <SharedLibraries key={id} libraryId={id} />; }
