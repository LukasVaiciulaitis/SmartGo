package com.example.smartgoprototype.di

import com.example.smartgoprototype.data.auth.CognitoAuthRepository
import com.example.smartgoprototype.domain.repository.AuthRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt bindings for authentication abstractions.
 *
 * The app depends on [AuthRepository] and DI decides which implementation to use.
 * This keeps ViewModels/UI independent of Cognito
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class AuthModule {

    @Binds
    @Singleton
    abstract fun bindAuthRepository(
        impl: CognitoAuthRepository
    ): AuthRepository
}
