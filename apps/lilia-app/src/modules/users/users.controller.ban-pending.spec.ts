import { UsersController } from './users.controller';

/**
 * F3-12.1 R7 — `GET /users/me` renvoyait la ligne `User` entière : un ban
 * programmé (motif, auteur) serait parti vers le livreur en pleine course.
 */
describe('UsersController — le ban programmé ne sort pas vers le compte visé', () => {
  const userService = {
    updateUser: jest.fn(),
  };
  const controller = new UsersController(userService as never, {} as never);
  const user = {
    id: 'u1',
    nom: 'Livreur A',
    role: 'LIVREUR',
    banPendingAt: new Date(),
    banPendingReason: 'fraude au code de remise',
    banPendingById: 'admin-1',
  };

  it('GET /users/me', () => {
    const { user: out } = controller.getProfile(user as never) as {
      user: Record<string, unknown>;
    };
    expect(out).toMatchObject({ id: 'u1', nom: 'Livreur A' });
    expect(out).not.toHaveProperty('banPendingAt');
    expect(out).not.toHaveProperty('banPendingReason');
    expect(out).not.toHaveProperty('banPendingById');
  });

  it('PUT /users/me', async () => {
    userService.updateUser.mockResolvedValue(user);
    const { user: out } = (await controller.updateProfile(
      user as never,
      {} as never,
    )) as { user: Record<string, unknown> };
    expect(out).not.toHaveProperty('banPendingReason');
  });
});
