import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import { CurrentUser, Public } from '../common/auth';
import type { AuthUser } from '../common/auth';
import { AuthService } from './auth.service';
import type { Session } from './auth.service';

class CredentialsDto {
  @IsString()
  @Length(9, 20)
  phoneNumber: string;

  @IsString()
  @Length(8, 128)
  @Matches(/(?=.*[A-Za-z])(?=.*\d)/, { message: 'password needs at least one letter and one digit' })
  password: string;
}

class LoginDto {
  @IsString()
  @Length(1, 20)
  phoneNumber: string;

  @IsString()
  @Length(1, 128)
  password: string;
}

class RefreshDto {
  @IsString()
  @Length(20, 200)
  refreshToken: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  register(@Body() dto: CredentialsDto): Promise<Session> {
    return this.auth.register(dto.phoneNumber, dto.password);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  login(@Body() dto: LoginDto): Promise<Session> {
    return this.auth.login(dto.phoneNumber, dto.password);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  refresh(@Body() dto: RefreshDto): Promise<Session> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  logout(@Body() dto: RefreshDto): Promise<void> {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }
}
