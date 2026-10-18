import {
  ActionIcon,
  Alert,
  AppShell,
  Avatar,
  Badge,
  Burger,
  Button,
  Divider,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconChevronDown,
  IconKey,
  IconLayoutDashboard,
  IconLogout,
  IconMoon,
  IconSchool,
  IconSun,
  IconTable,
} from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, Outlet, useLocation, useNavigationType } from 'react-router';
import { endpoints, qk } from '../api/endpoints';
import { useAuth, useUser } from '../auth/AuthContext';
import { homeFor } from '../auth/redirect';

export function BrandMark({ size = 30 }: { size?: number }) {
  return <img src="/favicon.svg" width={size} height={size} alt="" style={{ display: 'block' }} />;
}

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light', { getInitialValueInEffect: true });
  return (
    <Tooltip label={computed === 'dark' ? 'Light mode' : 'Dark mode'}>
      <ActionIcon
        variant="default"
        size="lg"
        aria-label="Toggle color scheme"
        onClick={() => setColorScheme(computed === 'dark' ? 'light' : 'dark')}
      >
        {computed === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}

/** Signed-in shell: header, class navigation sidebar, and the routed page in <Outlet />. */
export function AppLayout() {
  const user = useUser();
  const { logout } = useAuth();
  const location = useLocation();
  const navigationType = useNavigationType();
  const [opened, { toggle, close }] = useDisclosure();
  const classes = useQuery({ queryKey: qk.classes, queryFn: endpoints.listClasses });

  useEffect(() => close(), [location.pathname, close]);

  // No <ScrollRestoration /> is rendered: start new pages at the top but leave Back/Forward to the browser.
  // Keyed on the path only, so ?tab= and ?filter= updates keep the scroll position.
  useEffect(() => {
    if (navigationType !== 'POP') window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const home = homeFor(user.role);
  const classBase = user.role === 'teacher' ? '/teacher/classes' : '/student/classes';

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 270, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="lg"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" aria-label="Toggle navigation" />
            <UnstyledButton component={Link} to={home}>
              <Group gap={10} wrap="nowrap">
                <BrandMark />
                <Text fw={700} size="lg" visibleFrom="xs">
                  Excel Autograder
                </Text>
              </Group>
            </UnstyledButton>
          </Group>
          <Group gap="sm" wrap="nowrap">
            <ColorSchemeToggle />
            <Menu position="bottom-end" width={220}>
              <Menu.Target>
                <UnstyledButton aria-label="Account menu">
                  <Group gap={8} wrap="nowrap">
                    <Avatar name={user.name} color="initials" radius="xl" size={34} />
                    <Stack gap={0} visibleFrom="sm">
                      <Text size="sm" fw={600} lh={1.2}>
                        {user.name}
                      </Text>
                      <Text size="xs" c="dimmed" lh={1.2} tt="capitalize">
                        {user.role}
                      </Text>
                    </Stack>
                    <IconChevronDown size={14} />
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user.email}</Menu.Label>
                <Menu.Item leftSection={<IconKey size={16} />} component={Link} to="/account">
                  Change password
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  leftSection={<IconLogout size={16} />}
                  // The route guard sends the signed-out user to /login.
                  onClick={() => void logout()}
                >
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section>
          <NavLink
            component={Link}
            to={home}
            label="Dashboard"
            leftSection={<IconLayoutDashboard size={18} />}
            active={location.pathname === home}
          />
        </AppShell.Section>
        <Divider my="sm" label="Classes" labelPosition="left" />
        <AppShell.Section grow component={ScrollArea}>
          {classes.isPending ? (
            <Stack gap={6}>
              <Skeleton h={34} />
              <Skeleton h={34} />
            </Stack>
          ) : classes.data && classes.data.length > 0 ? (
            classes.data.map((c) => {
              const base = `${classBase}/${c.id}`;
              return (
                <NavLink
                  key={c.id}
                  component={Link}
                  to={base}
                  label={c.name}
                  description={
                    user.role === 'teacher'
                      ? `${c.studentCount} ${c.studentCount === 1 ? 'student' : 'students'}`
                      : c.teacherName
                  }
                  leftSection={<IconSchool size={18} />}
                  // Whole path segments only, so class 1 is not also active on /classes/10.
                  active={location.pathname === base || location.pathname.startsWith(`${base}/`)}
                />
              );
            })
          ) : (
            <Text size="sm" c="dimmed" px="sm">
              {user.role === 'teacher' ? 'No classes yet.' : 'You are not in any classes yet.'}
            </Text>
          )}
        </AppShell.Section>
        <AppShell.Section>
          <Divider my="sm" />
          <Group justify="space-between" px="xs">
            <Group gap={6}>
              <IconTable size={16} color="var(--mantine-color-dimmed)" />
              <Text size="xs" c="dimmed">
                Local copy
              </Text>
            </Group>
            <Badge variant="light" size="xs" tt="capitalize">
              {user.role}
            </Badge>
          </Group>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        {user.mustChangePassword && location.pathname !== '/account' && (
          <Alert color="yellow" mb="lg" icon={<IconKey />} title="You are using a temporary password">
            <Group justify="space-between">
              <Text size="sm">Your teacher created this account for you. Please choose your own password.</Text>
              <Button size="xs" component={Link} to="/account" color="yellow" variant="filled">
                Change password
              </Button>
            </Group>
          </Alert>
        )}
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
