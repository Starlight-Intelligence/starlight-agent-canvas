import type { Metadata } from 'next';
import './world.css';

export const metadata: Metadata = {
  title: 'World canvas',
  description: 'Node-based world canvas for people and agents.',
};

export default function WorldLayout({ children }: { children: React.ReactNode }) {
  return children;
}
