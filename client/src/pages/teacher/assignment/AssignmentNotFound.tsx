import { IconFileOff } from '@tabler/icons-react';
import { NotFoundCard } from '../../../components/NotFoundCard';
import { usePageTitle } from '../../../utils/usePageTitle';

/** Teacher pages for an assignment (or student) id that doesn't exist or belongs to another teacher's class. */
export function AssignmentNotFound({
  title = 'Assignment not found',
  description = 'This assignment may have been deleted, or the link is not quite right.',
}: {
  title?: string;
  description?: string;
}) {
  usePageTitle(title);
  return <NotFoundCard icon={<IconFileOff size={32} />} title={title} description={description} home="/teacher" />;
}
