/* eslint-disable prettier/prettier */
export class UpdateUserRoleDto {
    firebaseUid: string;
    newRole: 'ADMIN' | 'RESTAURATEUR' | 'LIVREUR' | 'CLIENT';
}