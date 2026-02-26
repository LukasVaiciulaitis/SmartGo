package com.example.smartgoprototype.di

import com.example.smartgoprototype.data.repository.RouteRepositoryStub
import com.example.smartgoprototype.domain.repository.RouteRepository
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt bindings for repositories.
 *
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class RepositoryModule {

    @Binds
    @Singleton
    abstract fun bindRouteRepository(
        impl: RouteRepositoryStub
    ): RouteRepository
}
