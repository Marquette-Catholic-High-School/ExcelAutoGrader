import { IconSchool } from '@tabler/icons-react';
import { NotFoundCard } from '../../../components/NotFoundCard';
import { usePageTitle } from '../../../utils/usePageTitle';

/** Shown for unknown class ids and for classes the user can no longer access (deleted, or removed from it). */
export function ClassNotFound({
  home,
  description = 'This class may have been deleted, or the link is not quite right.',
}: {
  home: string;
  description?: string;
}) {
  usePageTitle('Class not found');
  return <NotFoundCard icon={<IconSchool size={32} />} title="Class not found" description={description} home={home} />;
}
