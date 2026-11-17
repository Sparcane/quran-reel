import { redirect } from 'next/navigation';

/** The library is the front door; sending / there avoids a duplicate landing page. */
export default function Home() {
  redirect('/bibliotheque/');
}
